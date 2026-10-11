"""Browser chat UI -- matches agent.md's decided storefront surface (simple web chat, not
WhatsApp/Shopify). Deliberately minimal: no chat history persistence beyond the session,
no live token streaming.

Unlike the CLI's `confirm <nonce>` text command, this UI renders a literal button for the
confirmation step -- the cleaner version of the same out-of-band gate (see
agent/confirmation.py's docstring): clicking it calls `mark_confirmed()` directly, a code
path the LLM has no tool access to.

Run with: streamlit run webui/app.py

Streamlit reruns the whole script on every interaction, so a literal `with
telemetry.session_span(...):` would reopen a new trace per message. Instead its
`__enter__`/`__exit__` are called by hand, with the context manager itself stashed in
`st.session_state` (scoped per browser tab) so the trace stays open across reruns and is
only closed by the explicit "End session" button. `telemetry.configure_identity()` sets
plain `contextvars`, and Streamlit reruns aren't guaranteed to execute on the same thread,
so it's re-called at the top of every rerun rather than once at session start -- otherwise
IdentitySpanProcessor could stamp spans with a stale/empty identity.
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import streamlit as st

from agent.agent import build_agent
from agent.config import load_config
from agent.confirmation import latest_unconfirmed_pending, mark_confirmed
from agent.telemetry import configure_identity, init_telemetry, session_span, turn_span

ANONYMOUS_LABEL = "anonymous"


@st.cache_resource
def _setup():
    config = load_config()
    if config.otel_enabled:
        init_telemetry(config.otel_exporter_otlp_endpoint, config.enable_console_tracing)
    return config


def _run_turn(agent, user_message: str) -> str:
    # No live token streaming in this UI -- build_agent already gave the agent a no-op
    # callback_handler, so there's nothing to override here.
    with turn_span(user_message):
        return str(agent(user_message))


def _append(role: str, content: str) -> None:
    st.session_state.messages.append({"role": role, "content": content})


def _start_session(config, user_id: str) -> None:
    session_id = str(uuid.uuid4())
    session_cm = session_span(session_id, user_id)  # calls configure_identity() internally
    session_cm.__enter__()  # kept open across reruns -- see module docstring
    st.session_state.session_id = session_id
    st.session_state.user_id = user_id
    st.session_state.session_cm = session_cm
    st.session_state.agent = build_agent(config)
    st.session_state.messages = []


def _end_session() -> None:
    st.session_state.session_cm.__exit__(None, None, None)
    st.session_state.clear()
    st.rerun()


def main() -> None:
    config = _setup()

    st.set_page_config(page_title="Doraemon", page_icon="\U0001FA84")
    st.title("Doraemon -- from your imagination to your doorstep")
    st.caption("Mocked Arcade backend, DRY_RUN_CHECKOUT demo. Nothing here is a real purchase.")

    has_session = "session_id" in st.session_state

    with st.sidebar:
        st.subheader("Session")
        user_id_input = st.text_input(
            "User id (self-reported -- no auth system exists yet)",
            value=ANONYMOUS_LABEL,
            disabled=has_session,
            key="user_id_input",
        )
        if has_session:
            st.caption(f"session_id: {st.session_state.session_id}")
            st.caption(f"user_id: {st.session_state.user_id}")
            if st.button("End session"):
                _end_session()
        else:
            st.info("Session starts on your first message.")

    if has_session:
        # Reruns aren't guaranteed to run on the same thread that started the session --
        # the telemetry contextvars need re-asserting every rerun, not just once.
        configure_identity(st.session_state.session_id, st.session_state.user_id)

    for message in st.session_state.get("messages", []):
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
        if not has_session:
            _start_session(config, user_id_input or ANONYMOUS_LABEL)

        _append("user", user_message)
        st.chat_message("user").write(user_message)
        with st.chat_message("assistant"):
            with st.spinner("Thinking..."):
                response_text = _run_turn(st.session_state.agent, user_message)
            st.write(response_text)
        _append("assistant", response_text)
        if not has_session:
            st.rerun()  # re-render so the now-disabled user-id input reflects the new session


if __name__ == "__main__":
    main()
