"""The deliberately small v1 on-disk format shared with the JS reader."""

from __future__ import annotations

import hashlib

import regex

FORMAT = "roaring-static-search/v1"
TOKENIZER = "lower-unicode61-like/v1"
TOKEN_RE = regex.compile(r"[\p{L}\p{N}\p{Co}]+")
INDEX_RECORD_BYTES = 24


def normalize(value: str) -> str:
    return value.lower()


def tokens(value: str) -> list[str]:
    return TOKEN_RE.findall(normalize(value))


def bucket(term: str) -> str:
    return hashlib.sha256(term.encode("utf-8")).hexdigest()[:2]
