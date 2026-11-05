# Preserve selected figures and tables

Choose material for the researcher's task. A substantial reading usually benefits from the diagram that explains the method/framework and the table that carries its key comparison. Surveys also have useful taxonomy and protocol/dataset comparison tables; lack of experiments is not a reason to omit them. A focused text question or a paper with no useful visuals need not produce artificial image/table blocks. Do not impose a fixed count or copy every figure.

## Complete the handoff

1. Locate the original figure/table and inspect its page. Prefer the original PDF rendering when layout, arrows, merged headings or vector graphics matter; embedded-image extraction alone can miss vector figures.
2. Crop the selected figure/table with readable labels, legends, row/column headings and caption. Keep a larger source range if a tight crop is uncertain. Open the resulting image to check it, rather than assuming a successful command produced a useful crop.
3. Put the actual crop in the session `out/` directory. Upload it with `transfer_asset`, using a stable key for that file. A temporary file elsewhere, an image-view tool call and the original PDF are not extracted assets in the node.
4. Add an `image` or `table` block, or attach the representation to a related existing block. Use the upload's assetId and a sourceRef pointing to the PDF, page and original figure/table number. Keep the explanation close to the visual.
5. If structured table values are useful and can be checked, preserve them as `table.payload.columns/rows` or an uploaded XLSX. This applies to qualitative text comparisons too. Retain the source screenshot alongside the transcription; mark uncertainty and avoid silently correcting the paper's claims. TeX rendering is optional, not an extra compulsory format.
6. Check the candidate's returned block types and asset inventory. Selected visuals must reach the candidate before reporting that they are saved. If extraction failed, state which material is missing and why; an image-only table is acceptable when reliable values are unavailable.

## Minimal product use

After your native tools have written `out/framework.png`, call:

```json
{
  "direction": "upload",
  "relativePath": "out/framework.png",
  "idempotencyKey": "paper-framework-v1"
}
```

Upload a table crop in the same way. Then create or extend a candidate using actual returned IDs. This is a synthetic shape example for adding material to an existing node; replace every title, value, ID and source locator with verified data:

`relativePath` starts at the transfer directory: pass `out/framework.png`, not `.topolumia-transfer/session/out/framework.png`. A PDF source is `kind:"file"`; for multiple source pages use `locator:{page:"3, 7"}`, not a `document` kind or `pages` key.

```json
{
  "reason": "Preserve the framework and comparison from the reading",
  "nodeChanges": [{
    "nodeId": "node:returned-id",
    "addBlocks": [
      {
        "title": "Figure 2 - Framework",
        "type": "image",
        "payload": {"caption": "Original framework, source page 3", "alt": "Source framework diagram"},
        "representations": [{"kind": "asset", "assetId": "asset:uploaded-figure", "role": "source"}],
        "sourceRefs": [{"kind": "figure", "value": "Figure 2", "assetId": "asset:original-pdf", "locator": {"page": "3", "figure": "2"}}]
      },
      {
        "title": "Table 2 - Comparison",
        "type": "table",
        "payload": {"columns": [{"key": "aspect", "label": "Aspect"}, {"key": "method", "label": "Method"}], "rows": [{"aspect": "Example source aspect", "method": "Verified source value"}]},
        "representations": [{"kind": "asset", "assetId": "asset:uploaded-table-crop", "role": "source"}],
        "sourceRefs": [{"kind": "table", "value": "Table 2", "assetId": "asset:original-pdf", "locator": {"page": "7", "table": "2"}}],
        "review": "needs_review"
      }
    ]
  }]
}
```

Use these same nested blocks in `create_candidate.nodes` for a new paper. For an already pending proposal, call `edit_candidate` with candidateId, its observed expectedRevision and nodeChanges; only new material needs resending. A table can be representation-only when reliable structured values are unavailable. Do not attach a synthetic recreation as the paper's original figure.
