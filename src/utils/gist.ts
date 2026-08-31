import { request } from "@octokit/request"
import { GitHubUser, Note, NoteId } from "../schema"
import { inlineNoteEmbeds } from "./inline-note-embeds"
import { stripWikilinks } from "./strip-wikilinks"

/**
 * Prepares note content for publishing as a gist:
 * 1. Inlines note embeds as blockquotes
 * 2. Strips wikilinks to plain text
 */
export function prepareNoteForGist(content: string, notes: Map<NoteId, Note>): string {
  const contentWithInlineEmbeds = inlineNoteEmbeds(content, notes)
  return stripWikilinks(contentWithInlineEmbeds)
}

export async function createGist({
  note,
  githubUser,
  notes,
}: {
  note: Note
  githubUser: GitHubUser
  notes: Map<NoteId, Note>
}) {
  const filename = `${note.id}.md`

  try {
    const content = prepareNoteForGist(note.content, notes)

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
