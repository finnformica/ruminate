import { request } from "@octokit/request"
import { GitHubUser, Note } from "../schema"

export async function createGist({ note, githubUser }: { note: Note; githubUser: GitHubUser }) {
  const filename = `${note.id}.md`

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
