import httpx
from datetime import datetime
from fastapi import HTTPException
from app.config import settings
from app.schemas import NLPParsedOutput


async def parse_natural_language_command(user_prompt: str) -> NLPParsedOutput:
    """Parse a natural-language event request using the configured LLM provider.

    This endpoint intentionally fails clearly when the provider is unavailable.
    It must not fabricate a calendar event as an offline fallback.
    """
    now = datetime.now().replace(second=0, microsecond=0)
    system_prompt = (
        f"You are a calendar scheduling parser. Current reference time is {now.isoformat()} "
        f"({now.strftime('%A')}). Convert the user's request into a structured JSON object "
        "matching the exact schema. Calculate exact ISO 8601 dates relative to the reference time."
    )
    schema = NLPParsedOutput.model_json_schema()

    if settings.LLM_PROVIDER == "ollama":
        url = f"{settings.OLLAMA_BASE_URL.rstrip('/')}/api/chat"
        request_body = {
            "model": settings.OLLAMA_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "format": schema,
            "stream": False,
            "options": {"temperature": 0.1},
        }
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(url, json=request_body)
                response.raise_for_status()
            return NLPParsedOutput.model_validate_json(response.json()["message"]["content"])
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            raise HTTPException(
                status_code=503,
                detail=(
                    "The local Ollama model is unavailable or returned an invalid response. "
                    "Start Ollama and pull the configured model, or use the no-key local "
                    "timetable optimizer in the web app. No event was created."
                ),
            ) from exc

    if not settings.CLOUD_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="No cloud LLM API key is configured. Select Ollama for local AI or use the local timetable optimizer.",
        )

    url = f"{settings.CLOUD_BASE_URL.rstrip('/')}/chat/completions"
    request_body = {
        "model": settings.CLOUD_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
    }
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {settings.CLOUD_API_KEY}"},
                json=request_body,
            )
            response.raise_for_status()
        return NLPParsedOutput.model_validate_json(response.json()["choices"][0]["message"]["content"])
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        raise HTTPException(
            status_code=503,
            detail="The configured cloud LLM could not complete the request. No event was created.",
        ) from exc
