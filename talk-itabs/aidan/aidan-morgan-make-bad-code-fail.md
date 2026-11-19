# Quality gates for agents: Make bad code fail

**Aidan Morgan, Bankwest**

*Talk notes, packaged by iTabs · talk.itabs.co/aidan*

> Notes compiled by Jon Gwynne from photos of the slides, so a few details may be slightly off.

---

## The big idea

**Make the build say no, so you don't have to.**

When an AI agent writes code, don't rely on asking it nicely or reviewing everything by hand. Set up quality gates that automatically fail bad code, and lock them so the agent can't get around them.

## Key points

1. **Check what you can measure.** Readable, tested, structured, safe. If you can measure it, don't ask for it.
2. **Wire it into every loop, and lock it.** Hooks that exit 2, a required CI check, rules the agent can't edit.
3. **Ratchet, then grow it.** Baseline today, fail only on worse. Every repeated review comment becomes a house rule.
4. **A green build is not the whole story.** Gates stop bad code, but they don't catch the wrong fix or keep your team understanding the system.

## Aidan's quality gate checks

**What to check:** anything you can measure.

| Check | The question it answers |
|-------|-------------------------|
| Readable | Can a person follow this code? |
| Tested | Is it covered by tests that pass? |
| Structured | Does it follow the project's structure and rules? |
| Safe | Is it free of known security problems? |

**Where the gates run:** every loop, locked down.

- **Agent hooks that exit 2:** the agent is stopped and told to fix the problem before it can finish.
- **A required CI check:** code can't be merged until it passes.
- **Rules the agent can't edit:** so it can't "fix" a failure by loosening the rule.

**How the gates tighten:** a ratchet.

- Record today's numbers as the baseline.
- Fail only on new or worse code.
- Turn every repeated review comment into a house rule.

## Your tech debt, now on a payment plan

A **big-bang gate** finds 1,284 problems on day one, and by day two someone switches it off.

A **baseline gate** records today's numbers, fails only on new or worse code, and tightens one step a month.

## This sprint

**Add one gate: your most-failed check, in a Stop hook and in CI.**

---

## How to apply this to your own project

Copy everything in the box below and paste it into your own AI (Claude, ChatGPT, Copilot, whatever you use).

```text
I watched Aidan Morgan's talk "Quality gates for agents: Make bad code fail".
The idea: make the build say no, so you don't have to. Set up automatic quality
gates so bad code (including code an AI agent writes) fails loudly and early.

His three rules:
1. Check what you can measure: readable, tested, structured, safe.
   If you can measure it, don't ask for it.
2. Wire it into every loop, and lock it: agent hooks that exit 2,
   a required CI check, rules the agent can't edit.
3. Ratchet, then grow it: record a baseline today, fail only on new or
   worse code, tighten one step a month. Every repeated review comment
   becomes a house rule.

His warning: a green build is not the whole story. Gates don't catch the
wrong fix, and they don't keep the team understanding the system.

Help me apply this to my own project, one gate at a time:

1. First ask me what my project is: language, framework, how I run tests,
   where the code lives (e.g. GitHub), how it's deployed, and which AI
   coding agent I use, if any.
2. For each of the four checks (readable, tested, structured, safe), tell me
   whether I already have it, and if not, the simplest tool for my stack.
3. Ask me which check fails most often today. That's the first gate.
4. Set it up as a baseline gate, not a big-bang one: record today's numbers
   and fail only on new or worse code.
5. Wire it in twice: as a Stop hook (exit code 2) in my coding agent, and as
   a required check in CI. Give me the exact files and commands.
6. Show me how to stop the agent editing the gate's rules or config.
7. Have me make it fail on purpose once, so I can see it really blocks bad code.
8. Then suggest the next gate and stop.

Keep explanations short and plain. Ask before assuming anything about my setup.
```

---

*Made with iTabs · Jon · 0421 508 009 · jgwynne7@gmail.com*
