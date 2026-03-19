# Logseq Project Tracker — Browser Extension

Track all your Logseq projects, AI conversation threads, news, events, and requests directly from your browser toolbar.

## Features

- **🗂 Projects tab** — Lists every page tagged `#project` in your Logseq graph, grouped by program. Click a project to expand and browse its recent blocks and AI thread conversations.
- **➕ Create programs/projects** — From the Projects tab, create a program page and create new project pages under that program directly from the popup.
- **⚡ RDS 81346 quick action** — One click creates or opens `RDS/81346 #Project` with starter `#request`, `#event`, and `#news` blocks.
- **📡 Feed tab** — Timeline of blocks tagged `#news`, `#event`, or `#request` across all project pages. Filter by type.
- **↗ Open in Logseq** — One click navigates Logseq directly to the project page.
- **Add notes** — Append a new block to any project page without leaving the browser.
- **Auto-refresh** — Background worker refreshes data every 2 minutes and shows a badge count for new feed items.
- **Offline-safe** — Shows cached data when Logseq is not running.

## Setup

### Prerequisites

- Logseq Desktop with the **HTTP API server** enabled  
  `Logseq → Settings → Advanced → Enable HTTP API server`
- Your graph must use the **DB format** (page tags via `#project` use `block/tags`)

### Logseq side

1. Tag each project page with `#project` or `#Project`.
  Supported style: page titles like `Drivstoffapp #Project` are detected automatically.
2. Optionally add a `program::` property to each project page so the extension can group them:
   ```
   program:: My Program Name
   ```
   Alternatively, use Logseq namespaces: `Programs/My Project` — the extension will split on `/` automatically.
3. Tag any block in a project page with `#news`, `#event`, or `#request` to have it appear in the Feed.

### Installing the extension

1. Open Chrome/Edge → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `extension/` folder in this directory

### Configuring the extension

Click ⚙️ in the extension popup:

| Field | Default | Description |
|-------|---------|-------------|
| HTTP Server Port | `12315` | Must match Logseq's HTTP server port |
| Auth Token | *(blank)* | Copy from Logseq → Settings → Advanced → HTTP Server |
| Program Property | `program` | Page property name used to group projects under programs |

## Creating Programs and Projects

In the **Projects** tab:

1. Click **Add Program / Project**
2. In the **Program** sub-tab, create a program page (default namespace style: `programs/<name>`)
3. Switch to the **Project** sub-tab, pick a program, and create a project

New projects are created as:

```
<program>/<project> #Project
```

The popup updates the list immediately without forcing a full reload.

## RDS 81346 one-click flow

In the **Projects** tab, click **Create/Open RDS 81346** to:

1. Ensure the page `RDS/81346 #Project` exists
2. Set project properties (`program` and `project-id`)
3. Seed starter blocks if this is the first creation
4. Open the page directly in Logseq

## Project structure

```
extension/
├── manifest.json   Chrome extension manifest (MV3)
├── background.js   Service worker — periodic refresh, badge count
├── popup.html      Popup UI structure
├── popup.css       Catppuccin Mocha dark theme styles
└── popup.js        All popup logic (data fetch, render, events)
```

## How projects are found

The extension queries Logseq using the HTTP API:

```clojure
{:query [:find (pull ?b [:block/original-name ...])
  :where
  [?b :block/tags ?t]
  [?t :block/title "project"]]}
```

This returns every page that carries the project tag (case-insensitive). If tag indexing is unavailable, it falls back to:

- page titles including `#Project`
- namespaced pages under `programs/`
- pages carrying the configured program property (default `program`)

## How feed items are found

Three separate queries run for `#news`, `#event`, and `#request` tags, pulling the block content and its parent page name. Results are merged and sorted by last-updated time.

## AI thread detection

When viewing a project's blocks, the extension applies a simple heuristic to visually mark AI vs. human messages:

- Lines starting with `AI:`, `Assistant:`, `GPT:`, `Claude:`, `Copilot:` → 🤖  
- Lines starting with `User:`, `Human:`, `Me:`, `Q:` → 👤

Nested blocks (replies) are shown in collapsible `<details>` sections.
