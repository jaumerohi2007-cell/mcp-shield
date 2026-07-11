# MCP-Shield: Launch Templates 📢

This document contains promotional templates for publishing **MCP-Shield** to the developer and security communities.

---

## 1. Hacker News (Show HN)

* **Title:** `Show HN: MCP-Shield – A local-first security firewall for Claude Code and MCP agents`
* **Text:**

```text
Hi HN,

With the rise of autonomous agents like Claude Code, Cursor, and custom MCP setups, we are giving AI systems direct write and execute access to our local developer environments.

But this introduces a massive new security risk: Indirect Prompt Injection. If an agent reads a poisoned README or web page containing hidden instructions, it can easily be tricked into running destructive commands (like rm -rf or exfiltrating SSH keys).

I built MCP-Shield, an inline security proxy that intercepts JSON-RPC over stdio.

How it works:
It wraps any target MCP server process, intercepts JSON-RPC lines, and filters them through a rules engine. Safe commands auto-approve, dangerous commands block, and suspicious commands (like curl or out-of-workspace writes) are parked while prompting a local dark-themed web dashboard where you can approve, deny, or modify the command arguments on the fly.

Technical details:
- O(n) Stdio Framing: Buffers raw chunks and splits them only on newlines to prevent O(n^2) performance hits on massive outputs (like base64 images).
- Duplicate-Key Protection: Re-serializes the JSON payload canonically to block parser differential attacks.
- Unicode Normalization: Runs NFKC normalization on tool outputs to detect obfuscated prompt injection attempts.

It's open-source, runs 100% locally on your machine, and has zero analytics/telemetry.

Repo: https://github.com/jaumerohi2007-cell/mcp-shield

I'd love to hear your thoughts on agent security and how you're securing your local agentic workflows!
```

---

## 2. Reddit (r/selfhosted, r/node, r/ArtificialIntelligence)

* **Title:** `I built MCP-Shield: A local dark-themed security firewall to protect your terminal from AI Agent prompt injections`
* **Text:**

```text
Hey everyone,

Like many of you, I've been using tools like Claude Code and other autonomous agents to code faster in my terminal. However, the security aspect is terrifying. Giving an AI full permission to run terminal commands means a single malicious file or prompt injection on a website could wipe your workspace or steal credentials.

To solve this, I created MCP-Shield. It’s a local proxy that intercepts tool executions before they hit your system and displays them in a premium glassmorphic dashboard.

Key Features:
- 🚫 Command & File Firewall: Automatically blocks destructive commands and warns you about out-of-workspace file writes.
- 🔄 Interactive Approval Queue: Pauses suspicious commands and lets you approve, deny, or edit the arguments directly from your browser.
- 🧼 Prompt Injection Sanitizer: Detects and neutralizes prompt injections inside tool outputs before they reach the AI context.
- 🔒 100% Local & Privacy-focused: Runs entirely on localhost, no data sent to external clouds.

You can install it globally via npm:
npm install -g @jrooig/mcpshield

And wrap any server:
mcp-shield --port 3000 -- npx -y @modelcontextprotocol/server-everything

Check out the source code and README here: https://github.com/jaumerohi2007-cell/mcp-shield

Let me know what you think or if there are any default rules you would add!
```

---

## 3. X (Twitter)

* **Tweet 1 (Hook):**
```text
🚨 AI coding agents like Claude Code can execute commands on your machine. But what if they read a poisoned README or web page?

They can be hijacked to wipe your files or steal SSH keys.

That's why I built MCP-Shield: A zero-trust local firewall for AI agents. 🧵 👇

(Attach screenshot of your Dashboard)
```

* **Tweet 2:**
```text
MCP-Shield sits as an inline proxy on stdio, intercepting JSON-RPC messages in real-time.

✅ Safe commands: Auto-approved.
❌ Destructive commands: Instantly blocked.
⚠️ Suspicious actions: Paused for manual authorization.
```

* **Tweet 3:**
```text
It comes with a premium local dashboard (Express + Socket.io) where you can inspect logs, see security levels, and even EDIT command arguments on the fly before letting the AI run them.
```

* **Tweet 4 (Link):**
```text
Open-source, 100% local, and installs in seconds:
📦 npm install -g @jrooig/mcpshield

Star the repo on GitHub: https://github.com/jaumerohi2007-cell/mcp-shield 🛡️
```
