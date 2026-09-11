# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ruminate is a simple note-taking web application built with React and TypeScript. It enables users to capture and organize their thoughts with features like wikilinks, tags, templates, and GitHub synchronization.

## Development Commands

### Core Development

- `npm run dev` - Start the Vite dev server (frontend only)
- `npm run dev:worker` - Build and serve the full app + API via `wrangler dev`
- `npm run build` - Build for production (includes TypeScript compilation)
- `npm run preview` - Preview production build locally

### Testing

- `npm test` - Run all tests once
- `npm run test:watch` - Run tests in watch mode

### Code Quality

- `npm run lint` - Run ESLint on source files
- `npm run format` - Format code with Prettier

### Storybook

- `npm run dev:storybook` - Start Storybook development server
- `npm run build:storybook` - Build Storybook for production
- `npm run test:storybook` - Run Storybook tests
- `npm run test:storybook:watch` - Run Storybook tests in watch mode

### Other

- `npm run benchmark` - Run performance benchmarks

## Architecture

### State Management

- **Global State**: Jotai atoms (src/global-state.ts); the GitHub identity is resolved at boot by the auth atoms there
- **File System**: Integrates with isomorphic-git for Git operations and uses lightning-fs for browser file system
- **GitHub Integration**: Handles authentication, repository cloning, and synchronization

### Key Components

- **Note System**: Notes are parsed from markdown files with frontmatter support
- **Editor**: A custom block/outline editor (Logseq-style) that parses each note into blocks (`src/components/block-editor/`, `src/blocks/`)
- **Routing**: Uses TanStack Router for file-based routing
- **Templates**: Support for note templates with input variables
- **Voice Assistant**: OpenAI integration for voice conversations

### Data Flow

1. Markdown files are stored in a Git repository (GitHub integration)
2. Files are parsed into Note objects with extracted metadata (tags, links, dates)
3. Notes are indexed and made searchable using fast-fuzzy
4. UI components subscribe to state changes via Jotai atoms
5. Changes are automatically synced back to GitHub

### Core Technologies

- **Frontend**: React 18, TypeScript, Vite
- **Styling**: Tailwind CSS with custom design system
- **Editor**: Custom block/outline editor (`src/components/block-editor/`)
- **State**: Jotai
- **Git**: isomorphic-git + lightning-fs
- **Routing**: TanStack Router (file-based)
- **UI Components**: Radix UI primitives + Base UI
- **Markdown**: Unified/remark ecosystem

### File Structure

- `src/components/` - React components with Storybook stories
- `src/routes/` - TanStack Router route definitions
- `src/hooks/` - Custom React hooks
- `src/utils/` - Utility functions and helpers
- `src/components/block-editor/` - The block/outline editor
- `src/blocks/` - Block parsing, serialization, and operations
- `src/remark-plugins/` - Custom remark plugins for markdown processing
- `src/styles/` - CSS files and styling
- `worker/` - Cloudflare Worker (serves the SPA + API routes)

## Development Notes

### Testing

- Uses Vitest for unit tests
- Storybook for component testing and documentation
- Test files should be co-located with source files using `.test.ts` suffix

### Code Style

- Prettier configuration: no semicolons, trailing commas, 100 character line length
- ESLint rules enforced for TypeScript, React, and accessibility

### Before Committing

- Run `npm run format` to format code
- Run `npm run lint` to check for errors
- Run `npm run knip` to check for dead code (unused files, dependencies, exports)

### Git Integration

- The app operates on a Git repository stored in the browser's filesystem
- Uses isomorphic-git for all Git operations
- Automatic synchronization with GitHub repositories

### Performance

- Bundle analysis available via `npm run build` (generates dist/stats.html)
- PWA configuration for offline functionality
- Lazy loading and code splitting implemented
