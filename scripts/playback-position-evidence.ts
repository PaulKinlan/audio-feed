/**
 * The evidence-README options of the playback-position browser proof, in one shared place
 * (audio-feed-i98g1).
 *
 * WHY THIS EXISTS. docs/evidence/audio-feed-kzi/README.md is now a two-writer file: the proof
 * regenerates its region on every run and a human curates the prose around it. The byte-identity
 * pin - "the committed README must be regeneration-stable against the generator" - has to run in
 * the fast gate, but the proof itself is a browser script whose module top level LAUNCHES the
 * proof, so a test cannot import the options from it. They live here instead, and both the proof
 * (scripts/playback-position-browser-proof.ts) and the pin (tests/evidence_readme_test.ts) read
 * this one definition, so the options cannot drift apart from the file they generate.
 *
 * The `dir` is deliberately NOT here: scripts/evidence-census.ts resolves a write target from the
 * `dir` property of the writeEvidenceReadme call literal itself, so the proof keeps naming its
 * slice inline.
 */

export const PLAYBACK_POSITION_EVIDENCE: {
  title: string;
  script: string;
  asserts: string[];
} = {
  title: "Browser Acceptance Proof: audio-feed-kzi",
  script: "scripts/playback-position-browser-proof.ts",
  asserts: [
    "playback position 45s saved to localStorage",
    "row displays 'Resume from 0:45' badge",
    "play button action is 'resume'",
    "distinct 'Play from start' button is present",
    "clicking resume seeks audio to 45s",
    "clicking 'Play from start' clears stored position",
    "re-saved position 50s",
    "other user cannot resume user-1's playback position (per-user isolation)",
    "ended event clears stored position",
    "teardown: nothing still references the Chrome profile (directory removed and no process carries it)",
  ],
};
