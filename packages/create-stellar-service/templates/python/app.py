"""{{name}}: the service itself, a FastAPI app that knows nothing about payments.

The Provider Kit gateway (provider.config.json) stands in front of it. It publishes the manifest, takes the USDC
payment, queues jobs and keeps them for recovery, and POSTs only validated input here. Keep the models below in step
with the schemas in provider.config.json: agents read those before they pay.

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/uvicorn app:app --port 8000 --reload
"""

import re

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title={{nameJson}})


class SummarizeIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000, description="The text to summarize")
    sentences: int = Field(default=1, ge=1, le=5, description="How many sentences to keep")


class SummarizeOut(BaseModel):
    summary: str
    sentences: int = Field(description="Sentences in the text")
    words: int = Field(description="Words in the text")


@app.post(
    "/summarize",
    summary="Summarize",
    description="Returns the first sentences of an English text, with its sentence and word counts. Use it to shorten "
    "text before passing it on. Accepts up to 20,000 characters; it does not paraphrase.",
)
def summarize(body: SummarizeIn) -> SummarizeOut:
    # Your own work goes here, such as a model call. The gateway sends the job id in the Idempotency-Key header, so
    # a job it runs again after a restart can be recognized.
    parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", body.text) if part.strip()]
    return SummarizeOut(summary=" ".join(parts[: body.sentences]), sentences=len(parts), words=len(body.text.split()))
