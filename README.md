# Parquet Loader

A local FastAPI web app for uploading a parquet file and browsing the loaded data in a virtualized, scrollable grid.

## Run

```powershell
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`.

The app keeps uploaded parquet data in server memory. Set `MAX_UPLOAD_BYTES` to change the default 512 MB upload limit.
