# Logseq RDS 81346 Plugin

Create or open a pre-structured Logseq project page for RDS 81346.

## What it does

- Ensures the page `RDS/81346 #Project` exists
- Adds tracker-friendly page properties:
  - `program:: RDS`
  - `project-id:: RDS-81346`
- Seeds starter blocks (request, event, news, checklist) when the page is empty
- Opens the page after creation

Because the page includes `#Project`, it is automatically detected by the Project Tracker browser extension in this repository.

## Install

```bash
cd plugin
npm install
npm run build
```

Then load `plugin/` from Logseq:

1. Logseq → Plugins
2. Click **Load unpacked plugin**
3. Select this `plugin/` folder

## Commands

- Slash command: `RDS 81346: Create or Open`
- Command palette: `RDS 81346: Create or Open Project`
- Toolbar button: `RDS81346`
