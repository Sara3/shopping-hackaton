"""Interactive CLI entrypoint. Deliberately minimal (no OTel/telemetry/policy sidecar --
not needed for this MVP).

Run with: python -m agent.cli

The one thing this driver does that the agent itself cannot: parse a literal
`confirm <nonce> [override]` command and call `agent.confirmation.mark_confirmed()`
directly. That call never goes through the LLM -- see agent/confirmation.py's docstring
for why that split matters.
"""

from __future__ import annotations

import re
import sys

from agent.agent import build_agent
from agent.config import load_config
from agent.confirmation import mark_confirmed

CONFIRM_RE = re.compile(r"^confirm\s+(\S+)(\s+override)?\s*$", re.IGNORECASE)


def _print_banner() -> None:
    print("=" * 72)
    print(" Doraemon -- commerce agent (mocked Arcade backend, DRY_RUN_CHECKOUT demo) ")
    print("=" * 72)
    print("Describe a product you want. Type 'exit' to quit.")
    print("When shown a confirmation card, type exactly what it tells you to")
    print("(e.g. `confirm a1b2c3d4`) -- that's a real command this driver handles")
    print("directly, not something the agent interprets.")
    print("-" * 72)


def make_callback_handler():
    def _handler(**kwargs):
        if "data" in kwargs:
            print(kwargs["data"], end="", flush=True)
        elif "current_tool_use" in kwargs:
            name = kwargs["current_tool_use"].get("name")
            if name:
                print(f"\n  [calling tool: {name}]", flush=True)

    return _handler


def run_turn(agent, user_message: str) -> str:
    agent.callback_handler = make_callback_handler()
    result = agent(user_message)
    return str(result)


def main() -> None:
    config = load_config()
    agent = build_agent(config)

    _print_banner()
    while True:
        try:
            user_message = input("\nYou: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not user_message:
            continue
        if user_message.lower() in {"exit", "quit"}:
            break

        match = CONFIRM_RE.match(user_message)
        if match:
            nonce, override_flag = match.group(1), bool(match.group(2))
            ok, message = mark_confirmed(nonce, override=override_flag)
            print(f"[confirmation driver] {message}")
            if not ok:
                continue
            # Nudge the agent to proceed now that the out-of-band confirmation happened.
            # The agent still has to call create_checkout itself; this message doesn't
            # grant anything -- the tool-level check against agent.confirmation is what
            # actually allows the next create_checkout call to succeed.
            print("Agent: ", end="")
            run_turn(agent, f"(The user just confirmed nonce {nonce}. Proceed with checkout.)")
            print()
            continue

        print("Agent: ", end="")
        run_turn(agent, user_message)
        print()


if __name__ == "__main__":
    sys.exit(main() or 0)
