import { request } from "@octokit/request"
import { GitHubUser, Note } from "../schema"

/** A published gist is read by humans on github.com, so it is named after the
 * note rather than its (now opaque) id — sanitized to the characters a gist
 * filename tolerates, and falling back to the id when nothing usable is left. */
function gistFilename(note: Note): string {
  const slug = note.displayName
    .replace(/[^\w \-.]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
  return `${slug || note.id}.md`
}

export async function createGist({ note, githubUser }: { note: Note; githubUser: GitHubUser }) {
  const filename = gistFilename(note)

  try {
    const content = note.content

    const response = await request("POST /gists", {
      headers: {
        authorization: `token ${githubUser.token}`,
      },
      public: false,
      files: {
        [filename]: {
          content,
        },
      },
    })

    return response.data
  } catch (error) {
    console.error("Failed to create gist:", error)
    return null
  }
}

export async function deleteGist({ githubToken, gistId }: { githubToken: string; gistId: string }) {
  try {
    const response = await request("DELETE /gists/{gist_id}", {
      headers: {
        authorization: `token ${githubToken}`,
      },
      gist_id: gistId,
    })

    return response.status === 204
  } catch (error) {
    console.error("Failed to delete gist:", error)
    return false
  }
}
