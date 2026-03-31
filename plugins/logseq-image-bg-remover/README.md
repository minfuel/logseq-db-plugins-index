# Logseq Image BG Remover

Local Logseq plugin that removes image backgrounds for all images found in selected blocks.

## Features

- Works on multiple selected blocks at once
- Supports both URL images and local graph images
- Saves processed PNG files into the graph `assets/` folder
- Rewrites block image links to the new background-removed files

## Usage

1. Build and load [plugins/logseq-image-bg-remover/plugin](plugins/logseq-image-bg-remover/plugin) as an unpacked plugin in Logseq.
2. Select one or more blocks that contain markdown images (`![...](...)`).
3. Run one of:
   - Slash command: `Image BG Remover: Selected Blocks`
   - Command palette: `Image BG Remover: Selected Blocks`
   - Toolbar button: `BG`

## Notes

- Processing is local in the plugin runtime.
- First run may be slower because the segmentation model assets are initialized.
- Some remote URLs can fail if the host blocks fetching from desktop app contexts.

https://github.com/b-yp/logseq-image-editor
https://github.com/yutaodou/logseq-image-auto-resizer