"""Browser chat UI -- matches agent.md's decided storefront surface (simple web chat, not
WhatsApp/Shopify). Deliberately minimal: no chat history persistence beyond the session,
no live token streaming.

Unlike the CLI's `confirm <nonce>` text command, this UI renders a literal button for the
confirmation step -- the cleaner version of the same out-of-band gate (see
agent/confirmation.py's docstring): clicking it calls `mark_confirmed()` directly, a code
path the LLM has no tool access to.

Run with: streamlit run webui/app.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import streamlit as st

from agent.agent import build_agent
from agent.config import load_config
from agent.confirmation import latest_unconfirmed_pending, mark_confirmed


@st.cache_resource
def _setup():
    return load_config()


def _run_turn(agent, user_message: str) -> str:
    agent.callback_handler = None
    return str(agent(user_message))


def _append(role: str, content: str) -> None:
    st.session_state.messages.append({"role": role, "content": content})


def main() -> None:
    config = _setup()

    st.set_page_config(page_title="Doraemon", page_icon="\U0001FA84")
    st.title("Doraemon -- from your imagination to your doorstep")
    st.caption("Mocked Arcade backend, DRY_RUN_CHECKOUT demo. Nothing here is a real purchase.")

    if "agent" not in st.session_state:
        st.session_state.agent = build_agent(config)
        st.session_state.messages = []

    for message in st.session_state.messages:
        st.chat_message(message["role"]).write(message["content"])

    # Render a real Confirm button for any pending confirmation, instead of asking the
    # user to type a command -- same gate as the CLI, cleaner UI for it.
    pending = latest_unconfirmed_pending()
    if pending is not None:
        with st.container(border=True):
            st.write(
                f"**Confirm order:** product `{pending.product_id}` x{pending.quantity} -- "
                f"**${pending.total_cents / 100:.2f}**, ship to: {pending.stated_destination}"
            )
            if pending.over_spend_ceiling:
                st.warning("This exceeds the configured spend ceiling and needs an override confirmation.")
                clicked = st.button("Override ceiling & Confirm", key=f"confirm-override-{pending.nonce}")
                override = True
            else:
                clicked = st.button("Confirm & Checkout", key=f"confirm-{pending.nonce}")
                override = False
            if clicked:
                ok, result_message = mark_confirmed(pending.nonce, override=override)
                st.toast(result_message)
                if ok:
                    with st.spinner("Completing checkout..."):
                        response_text = _run_turn(
                            st.session_state.agent,
                            f"(The user just confirmed nonce {pending.nonce} via the web UI button. Proceed with checkout.)",
                        )
                    _append("assistant", response_text)
                st.rerun()

    user_message = st.chat_input("Describe a product you want...")
    if user_message:
        _append("user", user_message)
        st.chat_message("user").write(user_message)
        with st.chat_message("assistant"):
            with st.spinner("Thinking..."):
                response_text = _run_turn(st.session_state.agent, user_message)
            st.write(response_text)
        _append("assistant", response_text)
        st.rerun()


if __name__ == "__main__":
    main()
