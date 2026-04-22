const readline = require("node:readline");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let nextThreadId = 1;
let nextTurnId = 1;
let nextServerRequestId = 1;
const threadState = new Map();
const pendingServerRequests = new Map();

const startupRequestUserInputEnabled = process.argv.some((arg, idx, argv) => {
  if (arg === "--config") return argv[idx + 1] === "features.default_mode_request_user_input=true";
  return arg === "--config=features.default_mode_request_user_input=true";
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);

  if (msg.method === "initialize" && msg.id !== undefined) {
    respond(msg.id, {
      userAgent: "fake-codex/0.0.0",
      codexHome: "/tmp/fake-codex",
      platformFamily: "unix",
      platformOs: "linux",
    });
    return;
  }

  if (msg.method === "initialized") return;

  if (msg.method === "thread/start" && msg.id !== undefined) {
    const threadId = `th-${nextThreadId++}`;
    const threadConfigEnabled = msg.params?.config?.features?.default_mode_request_user_input === true;
    threadState.set(threadId, {
      requestUserInputEnabled: startupRequestUserInputEnabled || threadConfigEnabled,
    });
    respond(msg.id, { thread: { id: threadId } });
    notify("thread/started", { threadId, thread: { id: threadId, status: { type: "idle" } } });
    return;
  }

  if (msg.method === "thread/resume" && msg.id !== undefined) {
    const threadId = msg.params?.threadId;
    if (!threadState.has(threadId)) {
      threadState.set(threadId, {
        requestUserInputEnabled: startupRequestUserInputEnabled,
      });
    }
    respond(msg.id, { thread: { id: threadId } });
    return;
  }

  if (msg.method === "thread/name/set" && msg.id !== undefined) {
    respond(msg.id, { ok: true });
    return;
  }

  if (msg.method === "thread/unsubscribe" && msg.id !== undefined) {
    respond(msg.id, { status: "ok" });
    return;
  }

  if (msg.method === "turn/interrupt" && msg.id !== undefined) {
    respond(msg.id, { ok: true });
    return;
  }

  if (msg.method === "turn/start" && msg.id !== undefined) {
    const threadId = msg.params?.threadId;
    const turnId = `turn-${nextTurnId++}`;
    respond(msg.id, { turn: { id: turnId } });
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [] } });

    const enabled = threadState.get(threadId)?.requestUserInputEnabled === true;
    if (!enabled) {
      notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [] } });
      return;
    }

    const requestId = nextServerRequestId++;
    pendingServerRequests.set(requestId, { threadId, turnId });
    request(requestId, "item/tool/requestUserInput", {
      threadId,
      turnId,
      itemId: "call-1",
      questions: [
        {
          id: "favorite_primary_color",
          header: "Color",
          question: "What is your favorite primary color?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "red", description: "Choose red." },
            { label: "green", description: "Choose green." },
            { label: "blue", description: "Choose blue." },
          ],
        },
      ],
    });
    return;
  }

  if (msg.id !== undefined && pendingServerRequests.has(msg.id)) {
    const pending = pendingServerRequests.get(msg.id);
    pendingServerRequests.delete(msg.id);
    notify("serverRequest/resolved", {
      threadId: pending.threadId,
      requestId: msg.id,
    });
    notify("turn/completed", {
      threadId: pending.threadId,
      turn: {
        id: pending.turnId,
        status: "completed",
        items: [],
      },
    });
  }
});

rl.on("close", () => {
  process.exit(0);
});

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function request(id, method, params) {
  write({ jsonrpc: "2.0", id, method, params });
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
