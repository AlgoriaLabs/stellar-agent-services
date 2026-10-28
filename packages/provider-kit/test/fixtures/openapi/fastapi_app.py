# The FastAPI app behind fastapi-openapi.json, the fixture for `provider-kit init --openapi`. It is a made-up AI
# API with the shapes real ones have: Pydantic models, optional fields, enums, nested and recursive models,
# examples, an API key, and the endpoints the gateway can't call (GET, path and query parameters, uploads,
# non-JSON answers, arrays). Regenerate the fixture with FastAPI 0.115.12 and Pydantic 2.14.1:
#
#   python fastapi_app.py > fastapi-openapi.json
#
# Or serve it, for a live run: uvicorn fastapi_app:app --port 8000

import json
from enum import Enum
from typing import Optional

from fastapi import FastAPI, File, Response, Security, UploadFile
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, Field

app = FastAPI(title="Text Tools API", version="1.4.0", description="Summaries, translations and labels for English text.")
api_key = APIKeyHeader(name="X-API-Key")


class Language(str, Enum):
    en = "en"
    tr = "tr"
    de = "de"


class SummarizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20000, description="The text to summarize")
    sentences: int = Field(default=2, ge=1, le=10)
    language: Optional[Language] = None

    model_config = {"json_schema_extra": {"examples": [{"text": "Stellar settles in seconds. Fees are tiny.", "sentences": 1}]}}


class SummarizeResponse(BaseModel):
    summary: str
    sentences: int
    words: int

    model_config = {"json_schema_extra": {"examples": [{"summary": "Stellar settles in seconds.", "sentences": 2, "words": 7}]}}


class Glossary(BaseModel):
    source: str
    target: str


class TranslateRequest(BaseModel):
    text: str
    target: Language
    glossary: list[Glossary] = []


class TranslateResponse(BaseModel):
    text: str
    detected: Optional[Language] = None


class Node(BaseModel):
    label: str
    children: list["Node"] = []


class Labels(BaseModel):
    labels: dict[str, float]


@app.post("/summarize", tags=["Text"])
def summarize(request: SummarizeRequest) -> SummarizeResponse:
    """Returns the first sentences of an English text, with sentence and word counts. Use it to shorten text
    before passing it on. It does not paraphrase."""
    sentences = [part.strip() for part in request.text.split(".") if part.strip()]
    return SummarizeResponse(summary=". ".join(sentences[: request.sentences]) + ".", sentences=len(sentences), words=len(request.text.split()))


@app.post("/v1/translate", tags=["Text"])
def translate(request: TranslateRequest, key: str = Security(api_key)) -> TranslateResponse:
    """Translates text between English, Turkish and German."""
    return TranslateResponse(text=request.text, detected=Language.en)


@app.post("/classify/tree", summary="Label a tree")
def classify_tree(node: Node) -> Labels:
    return Labels(labels={node.label: 1.0})


@app.post("/random-fact")
def random_fact() -> SummarizeResponse:
    """A random fact about Stellar, as a one-sentence summary."""
    return SummarizeResponse(summary="Stellar settles in seconds.", sentences=1, words=4)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/documents/{document_id}/summarize")
def summarize_document(document_id: int) -> SummarizeResponse:
    return SummarizeResponse(summary="", sentences=0, words=0)


@app.post("/search")
def search(q: str) -> Labels:
    return Labels(labels={q: 1.0})


@app.post("/upload")
def upload(file: UploadFile = File(...)) -> Labels:
    return Labels(labels={})


@app.post("/languages")
def languages() -> list[Language]:
    return list(Language)


@app.post("/render", response_class=Response, responses={200: {"content": {"image/png": {}}}})
def render() -> Response:
    return Response(content=b"", media_type="image/png")


@app.post("/v0/summarize", deprecated=True)
def summarize_v0(request: SummarizeRequest) -> SummarizeResponse:
    return summarize(request)


if __name__ == "__main__":
    print(json.dumps(app.openapi(), indent=2))
