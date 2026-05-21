from __future__ import annotations

import json
import math
import os
import uuid
from datetime import date, datetime, time as datetime_time
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from time import time
from urllib.parse import unquote

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", 512 * 1024 * 1024))
MAX_PAGE_SIZE = 1000
MAX_WIDTH_SAMPLE_CHARS = 2048

app = FastAPI(title="Parquet Loader")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

DATASETS: dict[str, dict[str, object]] = {}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> FileResponse:
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


@app.post("/api/upload")
async def upload_parquet(request: Request) -> dict[str, object]:
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than the configured {format_bytes(MAX_UPLOAD_BYTES)} limit.",
        )

    contents = await request.body()
    if not contents:
        raise HTTPException(status_code=400, detail="Upload a parquet file before submitting.")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than the configured {format_bytes(MAX_UPLOAD_BYTES)} limit.",
        )

    filename = unquote(request.headers.get("x-file-name", "uploaded.parquet"))
    if not filename.lower().endswith((".parquet", ".parq")):
        raise HTTPException(status_code=400, detail="Only .parquet and .parq files are supported.")

    try:
        frame = pd.read_parquet(BytesIO(contents))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read parquet file: {exc}") from exc

    dataset_id = uuid.uuid4().hex
    memory_bytes = int(frame.memory_usage(deep=True).sum())
    DATASETS[dataset_id] = {
        "frame": frame,
        "filename": filename,
        "created_at": time(),
        "memory_bytes": memory_bytes,
    }

    return dataset_metadata(dataset_id, frame, filename, memory_bytes)


@app.get("/api/datasets/{dataset_id}")
def get_dataset(dataset_id: str) -> dict[str, object]:
    item = get_dataset_item(dataset_id)
    frame = item["frame"]
    assert isinstance(frame, pd.DataFrame)
    return dataset_metadata(
        dataset_id,
        frame,
        str(item["filename"]),
        int(item["memory_bytes"]),
    )


@app.get("/api/datasets/{dataset_id}/rows")
def get_rows(dataset_id: str, offset: int = 0, limit: int = 200) -> dict[str, object]:
    item = get_dataset_item(dataset_id)
    frame = item["frame"]
    assert isinstance(frame, pd.DataFrame)

    total_rows = len(frame)
    normalized_offset = max(0, min(offset, total_rows))
    normalized_limit = max(1, min(limit, MAX_PAGE_SIZE))
    window = frame.iloc[normalized_offset : normalized_offset + normalized_limit]

    rows = [
        [json_safe_cell(value) for value in row]
        for row in window.itertuples(index=False, name=None)
    ]

    return {
        "offset": normalized_offset,
        "limit": normalized_limit,
        "total_rows": total_rows,
        "rows": rows,
    }


@app.get("/api/datasets/{dataset_id}/columns/{column_index}/width")
def get_column_width(dataset_id: str, column_index: int) -> dict[str, object]:
    item = get_dataset_item(dataset_id)
    frame = item["frame"]
    assert isinstance(frame, pd.DataFrame)

    if column_index < 0 or column_index >= len(frame.columns):
        raise HTTPException(status_code=404, detail="Column was not found.")

    column = frame.iloc[:, column_index]
    longest_text = ""
    max_display_length = 0

    for value in column.to_numpy(dtype=object, copy=False):
        text = cell_display_text(value)
        text_length = len(text)
        if text_length > max_display_length:
            max_display_length = text_length
            longest_text = text

    sample_text = longest_text[:MAX_WIDTH_SAMPLE_CHARS]

    return {
        "column_index": column_index,
        "name": str(frame.columns[column_index]),
        "dtype": str(frame.dtypes.iloc[column_index]),
        "max_display_length": max_display_length,
        "sample_text": sample_text,
        "sample_truncated": len(longest_text) > len(sample_text),
    }


def get_dataset_item(dataset_id: str) -> dict[str, object]:
    item = DATASETS.get(dataset_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Dataset was not found. Upload the file again.")
    return item


def dataset_metadata(
    dataset_id: str, frame: pd.DataFrame, filename: str, memory_bytes: int
) -> dict[str, object]:
    return {
        "dataset_id": dataset_id,
        "filename": filename,
        "row_count": len(frame),
        "column_count": len(frame.columns),
        "memory_bytes": memory_bytes,
        "memory_label": format_bytes(memory_bytes),
        "columns": [
            {
                "name": str(name),
                "dtype": str(dtype),
                "index": index,
            }
            for index, (name, dtype) in enumerate(frame.dtypes.items())
        ],
    }


def json_safe_cell(value: object) -> object:
    if value is None:
        return None

    if isinstance(value, np.generic):
        value = value.item()

    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass

    if isinstance(value, float):
        if math.isnan(value):
            return None
        if math.isinf(value):
            return str(value)
        return value

    if isinstance(value, (datetime, date, datetime_time, pd.Timestamp)):
        return value.isoformat()

    if isinstance(value, Decimal):
        return str(value)

    if isinstance(value, bytes):
        return f"0x{value.hex()}"

    if isinstance(value, np.ndarray):
        return [json_safe_cell(item) for item in value.tolist()]

    if isinstance(value, (list, tuple)):
        return [json_safe_cell(item) for item in value]

    if isinstance(value, dict):
        return {str(key): json_safe_cell(item) for key, item in value.items()}

    return value


def cell_display_text(value: object) -> str:
    safe_value = json_safe_cell(value)
    if safe_value is None:
        return "NULL"
    if isinstance(safe_value, bool):
        return "true" if safe_value else "false"
    if isinstance(safe_value, (list, dict)):
        return json.dumps(safe_value, ensure_ascii=False, separators=(",", ":"))
    return str(safe_value)


def format_bytes(byte_count: int) -> str:
    size = float(byte_count)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} GB"
