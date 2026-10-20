import { describe, expect, it } from "vitest"
import { SHIPPED_LOCAL_STEPS } from "./corpus-schema"

/**
 * A migration that has shipped is never edited.
 *
 * Both ladders run each step once per database and remember only the version
 * it left behind — wrangler by the migration file's name, the local store by
 * `schema_version`. Neither looks at the text again, so a step edited after
 * it has run exists in two shapes at once: the edited one on every database
 * built since, the original on every database built before, with nothing to
 * say which is which. That is how 2026-10-10 went: three columns added to
 * v9's text a deploy after v9 ran left every device in between unable to
 * sync (`LOCAL_V10_SQL`).
 *
 * This test pins the content of every step that has shipped. When it fails,
 * the fix is never to update the hash here: revert the edit and add the
 * change as the next step (a new `LOCAL_V<n>_SQL`, or a new file under
 * `migrations/`), then pin that. The only hash to add is a new step's.
 */

const MIGRATION_FILES = import.meta.glob("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

const digest = async (text: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16)
}

/** Hashes of every step, keyed as the pinned lists are, for one comparison
 * that names every edited step at once. */
const hashes = async (steps: Record<string, string>) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(steps).map(async ([key, sql]) => [key, await digest(sql)] as const),
    ),
  )

const RULE =
  "A step that has shipped is never edited. Revert the change and add it as the next step, " +
  "then pin only that step's hash here."

describe("the migrations that have shipped", () => {
  it("the local store's steps are unchanged", async () => {
    const pinned: Record<string, string> = {
      3: "30397b31b2cbbcd5",
      4: "71e0f64d8447b68e",
      5: "aa9589298aa3a050",
      6: "b4d7b215d4c19ccf",
      7: "696334cff974efe5",
      8: "85366a541f57daf6",
      9: "34e8594abd0a8bf1", // as first shipped on 2026-10-10; the columns v10 adds are not here
      10: "90308fe01b9e8736",
      11: "3647126993277b6c",
    }
    expect(await hashes(SHIPPED_LOCAL_STEPS), RULE).toEqual(pinned)
  })

  it("the D1 migration files are unchanged", async () => {
    const pinned: Record<string, string> = {
      "0001_init.sql": "4cfd6abd236973f1",
      "0002_nodes.sql": "bab7e13b27cbf22f",
      "0003_control_plane.sql": "1f4f91af43f07b96",
      "0004_tenant_columns.sql": "90199c6f3c7265ec",
      "0005_row_seq.sql": "089bda59aadbff52",
      "0006_notes_id.sql": "bdf0eb8e32c7b5c6",
      "0007_mcp_tokens.sql": "f7092cb31ee229a6",
      "0008_note_type.sql": "91241966bb60fceb",
      "0009_mcp_token_usage.sql": "636ac281cfb022fb",
      "0010_user_email.sql": "1a8d32a22ef910bc",
      "0011_user_email_required.sql": "fabb3f8c3b50056c",
      "0012_shares.sql": "5a184f99bd5687ff",
      "0013_feature_flags.sql": "ace704e469cc94a5",
      "0014_invites.sql": "6592c469dd2c7e66",
      "0015_views.sql": "77c7f5954e92c826",
      "0016_retire_view_props.sql": "8e21a975661ea95a",
      "0017_share_views.sql": "8722b78adecfb04d",
      "0018_anthropic_keys.sql": "608ed199a03f0ff7",
      "0019_ai_usage.sql": "f4a680243e524a65",
      "0020_board_type.sql": "6fb488d1886c11d7",
      "0020_share_revoked_by.sql": "85b0bc0ec5741721",
      "0021_note_views.sql": "251f5dcbaed38f41",
      "0022_ai_history.sql": "aadcbea5ce6cbb65",
      "0023_events.sql": "71e19ec7350b93b6",
      "0024_event_hlc.sql": "1fb7422eeca1484c",
    }
    const files = Object.fromEntries(
      Object.entries(MIGRATION_FILES).map(([path, sql]) => [path.split("/").pop()!, sql]),
    )
    expect(await hashes(files), RULE).toEqual(pinned)
  })
})
