# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Removed
- **Chapter markers specification (audio-feed-bqt)**: Removed the unproduced `Chapter` type, `Episode.chapters`, `FeedEpisode.chaptersUrl`, and `<podcast:chapters>` RSS emitter. Gemini 3.8 Flash TTS outputs direct stream audio without alignment timestamps; advertising chapter URLs that 404 broke the Podcast 2.0 specification for podcast players.
