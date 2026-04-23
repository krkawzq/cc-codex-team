# Bug: `--format markdown` is broken twice — wrong wrapper and wrong renderer

Affects `message tail`, `message history`, `session context`, `session info` (any command accepting `--format markdown`).

The intent (per `docs/html-md-format.md`) is: **agent asks for markdown → CLI parses the JSON thread/turn data and emits agent-friendly HTML-markdown straight to stdout**, using tagged form:

```
<tag-name>{"id":"...","meta":"inline"}<\tag-name>
```
```
<tag-name> {"id":"...","meta":"..."}
<free-form markdown body>
<\tag-name>
```

Nesting is allowed (`<turn>` contains `<item>`, etc.). No JSON envelope wrapping anywhere.

## Bug A — `--format markdown` is wrapped in a JSON envelope

### Symptom

```bash
node dist/main.js -b $TOK message tail <session> -n 1 --format markdown
```

Actual stdout:
```json
{"ok":true,"data":{"session":"...","format":"markdown","markdown":"<tail> {...}\n\n<turn> ..."}}
```

Expected stdout:
```
<tail>{"session":"...","thread_id":"...","count":1,"generated_at":"..."}

<turn> {"id":"...","status":"completed","duration_ms":373658,"started_at":...,"completed_at":...}

<item>{"id":"item-1","type":"userMessage","text":"..."}<\item>

<item> {"id":"item-2","type":"agentMessage"}
...markdown prose...
<\item>

<\turn>

<\tail>
```

### Root cause

`src/cli/run.ts:dispatchCommand` unconditionally prints `JSON.stringify({ok:true, data: resp.result})`. The daemon handler does produce a `markdown` field (`src/daemon/handlers/message.ts:messageTail` + `messageHistory`, `src/daemon/handlers/session.ts:sessionContext`), but it's buried inside `data.markdown`.

### Fix

In `src/cli/run.ts:dispatchCommand`, when request's `flags.format === "markdown"` AND `resp.result?.markdown` exists AND no error:
```ts
process.stdout.write((resp.result.markdown as string) + "\n");
return 0;
```

Error envelope stays JSON (errors don't carry a markdown field). Agents distinguish by exit code + whether first byte is `<` or `{`.

Daemon handlers can then simplify: `result.markdown` becomes the ONLY thing returned when format=markdown (no need to also include the full structured data, since the markdown is already rendered from it).

## Bug B — renderer emits JSON inside `<item>` instead of markdown or inline form

### Symptom

What `renderTail` currently produces for a `userMessage` item:

```
<item> {"id":"item-1","type":"userMessage"}

{
  "type": "userMessage",
  "id": "item-1",
  "content": [
    {
      "type": "text",
      "text": "# Fix: `monitor events...`\n\nYou're a Codex worker..."
    }
  ]
}

<\item>
```

Two problems:
1. The body is literal JSON (pretty-printed), not markdown. Agents reading the tagged-markdown format expect the body to be human-readable prose.
2. If the only meaningful content IS the `text` field, this should collapse to inline form: `<item>{"id":"item-1","type":"userMessage","text":"..."}<\item>`. The block form (with empty-ish body) is wasteful.

Expected behavior per spec (`docs/html-md-format.md:17-54`):

- **Inline form** when all content fits in the JSON attributes:
  ```
  <item>{"id":"item-1","type":"userMessage","text":"..."}<\item>
  ```
- **Block form** when there's structural markdown body:
  ```
  <item> {"id":"item-2","type":"agentMessage"}
  
  Here's the analysis:
  
  - point A
  - point B
  
  <\item>
  ```
  with the text rendered directly as markdown (no `{...}` JSON dump, no code-fence wrapping).

- **Nested content** like tool-call outputs use their own sub-tags:
  ```
  <item> {"id":"item-3","type":"commandExecution","status":"completed"}
  
  <shell>{"cmd":"ls -la","cwd":"/repo","exit":0,"duration_ms":32}
  total 24
  drwxr-xr-x 5 ...
  <\shell>
  
  <\item>
  ```

### Root cause

`src/format/markdown.ts:renderTail` / `renderHistory` / `renderContext` emit the raw item JSON as block body instead of:
1. Checking whether the item type has a meaningful markdown body (agentMessage → yes; userMessage → usually no if only text; commandExecution → yes for stdout/stderr; fileChange → yes for diff)
2. Picking inline vs block form based on whether a body exists
3. Emitting the markdown body UNWRAPPED (no JSON pretty-print, no code fences around structured tag bodies)

### Fix outline

1. Add per-item-type renderer functions in `src/format/markdown.ts`:
   - `renderUserMessage(item)` → inline tag with `text` attr, or block with text body if multi-paragraph
   - `renderAgentMessage(item)` → block tag with `text` as markdown body
   - `renderCommandExecution(item)` → block tag wrapping `<shell>` sub-tag with stdout/stderr body
   - `renderFileChange(item)` → block tag wrapping `<file-patch>` sub-tag with diff body
   - `renderReasoning(item)` → block tag with summary or inline tag
   - etc. — each turn-item type from the codex-app-server protocol
2. Default fallback: `<item>{json stripped of verbose fields}<\item>` inline (not JSON pretty-print in body).
3. `<turn>` / `<history>` / `<tail>` root containers emit child items between their opening and closing tags, joined by blank lines, following the spec's nesting convention.
4. `<session-info>` per `docs/html-md-format.md:60-66` uses "markdown 列表" body form.

### Test regression

Add tests in `tests/format-markdown.test.ts` (or similar):
- userMessage with single-paragraph text → inline form
- agentMessage with multi-paragraph text → block form, body is the text rendered
- commandExecution → nested `<shell>` with stdout body (no JSON dump)
- empty item body → inline form with all metadata
- Assert body does NOT contain `"type":`, `{`, or other JSON syntax for types that have a natural markdown rendering

## Priority

Major. The output is currently unusable as "agent-friendly markdown" — it's JSON wrapped in tag labels. Both bugs compound: fix only Bug A and the output still has unreadable JSON item bodies; fix only Bug B and it's still buried in an envelope.

## Reported by

Claude orchestrator during 2026-04-22 dogfood run. Discovered while inspecting `fix-monitor` session output via `message tail --format markdown`.
