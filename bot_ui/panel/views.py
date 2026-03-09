from pathlib import Path
from functools import wraps
import os
import sys
from urllib.parse import quote

from django.conf import settings
from django.contrib import messages
from django.shortcuts import redirect, render
from django.urls import reverse
from django.views.decorators.http import require_http_methods

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import bot as agorium_bot  # noqa: E402

SESSION_FLAG = "agorium_bot_ui_authenticated"
SESSION_USER = "agorium_bot_ui_user"


def _persona_options() -> list[dict]:
    out: list[dict] = []
    for key, persona in agorium_bot.PERSONAS.items():
        out.append({
            "key": key,
            "display_name": persona.get("display_name", key),
            "bio": persona.get("bio", ""),
        })
    return out


def _load_debates() -> tuple[list[dict], str]:
    try:
        sb = agorium_bot.get_client()
        debates = agorium_bot.get_recent_debates(sb, limit=100)
        return debates, ""
    except Exception as e:
        return [], str(e)


def _safe_next_url(raw: str) -> str:
    value = str(raw or "").strip()
    if value.startswith("/") and not value.startswith("//"):
        return value
    return reverse("panel:dashboard")


def _login_redirect(request):
    next_url = quote(request.get_full_path(), safe="")
    return redirect(f"{reverse('panel:login')}?next={next_url}")


def require_panel_login(view_func):
    @wraps(view_func)
    def wrapped(request, *args, **kwargs):
        if not request.session.get(SESSION_FLAG):
            return _login_redirect(request)
        return view_func(request, *args, **kwargs)

    return wrapped


@require_http_methods(["GET", "POST"])
def login_view(request):
    next_url = _safe_next_url(request.GET.get("next") or request.POST.get("next"))
    configured_user = str(settings.BOT_UI_LOGIN_USERNAME or "").strip()
    configured_pass = str(settings.BOT_UI_LOGIN_PASSWORD or "")
    password_required = bool(configured_pass)

    if request.session.get(SESSION_FLAG):
        return redirect(next_url)

    if request.method == "POST":
        username = (request.POST.get("username") or "").strip()
        password = request.POST.get("password") or ""

        if not password_required:
            messages.error(
                request,
                "BOT_UI_LOGIN_PASSWORD is not set on this server. Set it and restart the app.",
            )
        elif username == configured_user and password == configured_pass:
            request.session[SESSION_FLAG] = True
            request.session[SESSION_USER] = username
            messages.success(request, "Signed in.")
            return redirect(next_url)
        else:
            messages.error(request, "Invalid login.")

    return render(
        request,
        "panel/login.html",
        {
            "next": next_url,
            "configured_username": configured_user,
            "password_required": password_required,
        },
    )


@require_http_methods(["POST"])
def logout_view(request):
    request.session.pop(SESSION_FLAG, None)
    request.session.pop(SESSION_USER, None)
    return redirect("panel:login")


@require_http_methods(["GET", "POST"])
@require_panel_login
def dashboard(request):
    personas = _persona_options()

    if request.method == "POST":
        persona_key = (request.POST.get("persona") or "").strip()
        action = (request.POST.get("action") or "argue").strip().lower()
        debate_id = (request.POST.get("debate_id") or "").strip() or None
        side_input = (request.POST.get("side") or "auto").strip().lower()
        response_length_input = (request.POST.get("response_length") or "").strip()

        valid_lengths = {"1", "2-3", "4-5", "6+"}
        response_length = response_length_input if response_length_input in valid_lengths else None

        forced_side = side_input if side_input in {"for", "against"} else None
        if action != "argue":
            forced_side = None

        if persona_key not in agorium_bot.PERSONAS:
            messages.error(request, "Invalid persona selected.")
            return redirect("panel:dashboard")

        if action == "argue" and not debate_id:
            messages.error(request, "Pick a debate to argue on.")
            return redirect("panel:dashboard")

        result = agorium_bot.execute_action(
            persona_key=persona_key,
            action=action,
            debate_id=debate_id,
            forced_side=forced_side,
            response_length=response_length,
        )

        if result.get("ok"):
            if result.get("action") == "argue":
                messages.success(
                    request,
                    f"{result.get('persona')} argued {result.get('side')} on \"{result.get('post_title') or result.get('post_id')}\" "
                    f"(source: {result.get('side_source')}).",
                )
            else:
                messages.success(
                    request,
                    f"{result.get('persona')} started a new debate: \"{result.get('post_title')}\".",
                )
        else:
            messages.error(request, result.get("error") or "Bot action failed.")

        return redirect("panel:dashboard")

    debates, load_error = _load_debates()

    env_missing = []
    if not os.environ.get("OPENAI_API_KEY"):
        env_missing.append("OPENAI_API_KEY")
    if not os.environ.get("SUPABASE_KEY"):
        env_missing.append("SUPABASE_KEY")

    context = {
        "personas": personas,
        "debates": debates,
        "load_error": load_error,
        "env_missing": env_missing,
        "session_username": request.session.get(SESSION_USER, ""),
    }
    return render(request, "panel/dashboard.html", context)
