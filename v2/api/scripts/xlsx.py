#!/usr/bin/env python3
"""Read validated flat XLSX or write string-only XLSX from newline-delimited JSON."""
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import zipfile
from xml.sax.saxutils import escape

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("legacy_excel", Path(__file__).resolve().parents[3] / "scripts" / "excel.py")
excel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(excel)

def write():
    base = io.BytesIO(excel.export([]))
    with zipfile.ZipFile(base) as skeleton, zipfile.ZipFile(sys.stdout.buffer, "w", zipfile.ZIP_DEFLATED) as target:
        sheet = "xl/worksheets/sheet1.xml"
        for name in skeleton.namelist():
            if name != sheet:
                target.writestr(name, skeleton.read(name))
        with target.open(sheet, "w") as data:
            data.write(b'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>')
            for i, line in enumerate(sys.stdin.buffer, 1):
                if i > 1048576:
                    raise ValueError("Excel row limit")
                cells = []
                for j, value in enumerate(json.loads(line), 1):
                    value = escape(re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str("" if value is None else value)))
                    cells.append(f'<c r="{excel.col(j)}{i}" t="inlineStr"><is><t xml:space="preserve">{value}</t></is></c>')
                data.write(f'<row r="{i}">{"".join(cells)}</row>'.encode())
            data.write(b'</sheetData></worksheet>')

if sys.argv[1] == "export":
    write()
elif sys.argv[1] == "import":
    payload = sys.stdin.buffer.read(3_000_001)
    if len(payload) > 3_000_000:
        raise ValueError("Upload too large")
    print(json.dumps(excel.read(payload)))
else:
    raise ValueError("Unknown operation")
