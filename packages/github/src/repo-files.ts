import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./client.js";

/**
 * Lists and reads a repository's files through the GitHub API.
 *
 * The orchestrator runs inside the cluster with no checkout, so this is how it
 * sees the repository. Returned as two plain functions rather than a class so
 * @srectl/retrieval can consume it without depending on Octokit.
 */
export interface RepoFileReader {
  listFiles: () => Promise<string[]>;
  readFile: (path: string) => Promise<string | null>;
}

/** Blobs above this are not source files worth indexing. */
const MAX_BLOB_BYTES = 400_000;

export function githubRepoFiles(gh: Octokit, ref: RepoRef, sha: string): RepoFileReader {
  // One tree call lists the whole repository; the alternative is walking
  // directories one request at a time, which is dozens of calls for a small
  // repo and rate-limits on a large one.
  let treeCache: Promise<Map<string, string>> | null = null;

  const tree = (): Promise<Map<string, string>> => {
    treeCache ??= (async () => {
      const { data } = await gh.rest.git.getTree({
        ...ref,
        tree_sha: sha,
        recursive: "1",
      });

      const out = new Map<string, string>();
      for (const entry of data.tree) {
        if (entry.type !== "blob" || !entry.path || !entry.sha) continue;
        if ((entry.size ?? 0) > MAX_BLOB_BYTES) continue;
        out.set(entry.path, entry.sha);
      }

      // A repository larger than the API returns in one page would be indexed
      // from a partial listing, and the missing files would then look deleted.
      // Better to refuse than to prune against an incomplete tree.
      if (data.truncated) {
        throw new Error(
          `GitHub truncated the tree listing for ${ref.owner}/${ref.repo}@${sha.slice(0, 7)}; ` +
            "indexing from a partial listing would delete the files it could not see.",
        );
      }

      return out;
    })();
    return treeCache;
  };

  return {
    async listFiles() {
      return [...(await tree()).keys()];
    },

    async readFile(path) {
      const blobSha = (await tree()).get(path);
      if (!blobSha) return null;

      // Read by blob SHA, not by path+ref: the blob endpoint is content
      // addressed, so it cannot race a push that moves the branch mid-index.
      try {
        const { data } = await gh.rest.git.getBlob({ ...ref, file_sha: blobSha });
        if (data.encoding !== "base64") return null;
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch {
        return null;
      }
    },
  };
}
