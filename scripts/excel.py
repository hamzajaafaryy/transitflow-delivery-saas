#!/usr/bin/env python3
"""Small standard-library XLSX reader/writer for simple tabular data; no macros/formulas executed."""
import sys, io, json, zipfile, xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

NS = {'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def col(n):
    s=''
    while n: n,r=divmod(n-1,26); s=chr(65+r)+s
    return s

def export(rows):
    cells=[]
    for i,row in enumerate(rows,1):
        fragments=[]
        for j,val in enumerate(row,1):
            value=escape(str(val if val is not None else ''))
            fragments.append(f'<c r="{col(j)}{i}" t="inlineStr"><is><t xml:space="preserve">{value}</t></is></c>')
        cells.append(f'<row r="{i}">{"".join(fragments)}</row>')
    sheet='<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+''.join(cells)+'</sheetData></worksheet>'
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml','<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Commandes" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml',sheet)
    return out.getvalue()

def read(data):
    rows=[]
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        members=z.infolist()
        if len(members)>150 or sum(x.file_size for x in members)>12_000_000: raise ValueError('Fichier XLSX trop volumineux')
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            root=ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in root.findall('m:si',NS): shared.append(''.join(t.text or '' for t in si.findall('.//m:t',NS)))
        if 'xl/worksheets/sheet1.xml' not in z.namelist(): raise ValueError('Première feuille introuvable')
        root=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
        for row in root.findall('.//m:sheetData/m:row',NS):
            values={}
            for cell in row.findall('m:c',NS):
                ref=cell.attrib.get('r','A1');letters=''.join(x for x in ref if x.isalpha())
                index=0
                for c in letters:index=index*26+ord(c.upper())-64
                typ=cell.attrib.get('t');val=cell.find('m:v',NS)
                if typ=='inlineStr':value=''.join(t.text or '' for t in cell.findall('.//m:t',NS))
                elif val is None:value=''
                elif typ=='s':value=shared[int(val.text)]
                else:value=val.text or ''
                if index and index<=100: values[index-1]=value
            if values: rows.append([values.get(n,'') for n in range(max(values)+1)])
            if len(rows)>5000:raise ValueError('Limite 5000 lignes')
    return rows

if __name__=='__main__':
    try:
        payload=sys.stdin.buffer.read(8_000_000)
        if sys.argv[1]=='export':sys.stdout.buffer.write(export(json.loads(payload)))
        elif sys.argv[1]=='import':sys.stdout.write(json.dumps(read(payload)))
        else:raise ValueError('Mode inconnu')
    except Exception as e:
        sys.stderr.write(str(e));sys.exit(1)
