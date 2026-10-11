# Doraemon

An AI commerce agent: describe a product in natural language, or show it a reference
picture, and it turns that into a real merchant listing — priced and routed to
fulfillment. Built for Arcade AI's "Shopping 3.0" hackathon (Oct 11, 2026, SF).

- Product spec and pipeline: [agent.md](agent.md)
- Rules of the road (security, confirmation gates, what the coding agent can/can't do):
  [agent_constitution.md](agent_constitution.md)
- Guidance for Claude Code working in this repo: [CLAUDE.md](CLAUDE.md)

Status: a running agent exists (Python + Strands Agents SDK + Anthropic Claude), against a
mocked Arcade backend — Arcade's live API isn't reachable yet. See
[RUNNING.md](RUNNING.md) to run it; see the Open/TBD section of [agent.md](agent.md) for
what's still unbuilt (photo intake, the live Arcade client).
