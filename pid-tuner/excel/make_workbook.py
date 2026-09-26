# Builds PI_Loop_Health.xlsx: loop health check + tuning calculator + printable report, all in Excel.
# Formulas only (no macros), classic functions (plus TEXTJOIN) so it recalculates fast and can be
# verified outside Excel. PI DataLink "Sampled Data" writes into Data!A2 (created once by the user).
#
#   python3 make_workbook.py                  -> PI_Loop_Health.xlsx (empty Data)
#   build(path, data=[...], loop={...})       -> used by verify_workbook.py / example file
from datetime import datetime

from openpyxl import Workbook
from openpyxl.chart import Reference, ScatterChart, Series
from openpyxl.comments import Comment
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.workbook.properties import CalcProperties
from openpyxl.worksheet.properties import PageSetupProperties
from openpyxl.worksheet.datavalidation import DataValidation

MAX_ROWS = 20000                 # data rows supported (Data!A2:A20001)
R0, R1 = 2, MAX_ROWS + 1         # first/last data row
TAG_ROWS = 50                    # loop table size on Setup

F = "Arial"
bold = Font(name=F, bold=True)
norm = Font(name=F)
blue = Font(name=F, color="0000FF")
green = Font(name=F, color="008000")
title = Font(name=F, bold=True, size=14)
big = Font(name=F, bold=True, size=13)
muted = Font(name=F, color="666666", italic=True)
yellow = PatternFill("solid", start_color="FFFF00")
head_fill = PatternFill("solid", start_color="DDEBF7")
thin = Side(style="thin", color="BBBBBB")
box = Border(left=thin, right=thin, top=thin, bottom=thin)
wrap = Alignment(wrap_text=True, vertical="top")
FILL = {
    "good": PatternFill("solid", start_color="E2F0D9"),
    "warn": PatternFill("solid", start_color="FFF2CC"),
    "bad": PatternFill("solid", start_color="F8CBAD"),
    "na": PatternFill("solid", start_color="EDEDED"),
}
LOOP_TYPES = ["flow", "pressure", "temperature", "level", "analyzer"]
METHODS = ["อัตโนมัติ", "Lambda", "SIMC", "IMC-PID", "Lambda averaging level", "SIMC tight level"]


def rng(col, sheet="Data", a=R0, b=R1):
    return f"{sheet}!${col}${a}:${col}${b}"


def cell(ws, ref, value, font=norm, fill=None, fmt=None, border=None, align=None):
    c = ws[ref]
    c.value = value
    c.font = font
    if fill:
        c.fill = fill
    if fmt:
        c.number_format = fmt
    if border:
        c.border = border
    if align:
        c.alignment = align
    return c


def status_rules(ws, rng_ref, first_cell):
    """Colour a status column by its text (the text itself always states the status)."""
    for word, key in (("ปกติ", "good"), ("ควรตรวจ", "warn"), ("มีปัญหา", "bad"), ("ไม่มีข้อมูล", "na"), ("ข้อมูล", "na")):
        ws.conditional_formatting.add(rng_ref, FormulaRule(formula=[f'{first_cell}="{word}"'], fill=FILL[key], stopIfTrue=True))


def build(path, data=None, loop=None, example_rows=None, tuning=None, show_only=None):
    """data: list of (datetime, pv, sv, mv, mode); loop: overrides for Setup/loop table (tests)."""
    wb = Workbook()
    names = {}

    def name(n, ref):
        names[n] = ref
        wb.defined_names[n] = DefinedName(n, attr_text=ref)

    loop = loop or {}

    # ───────────────────────── HowTo ─────────────────────────
    h = wb.active
    h.title = "HowTo"
    cell(h, "A1", "PI Loop Health: วิธีใช้", title)
    steps = [
        ("ครั้งแรก (ทำครั้งเดียว บนเครื่องที่มี PI DataLink)", None),
        ("1", "แท็บ Setup: ตรวจ PI server (B4), area prefix (B5), ชื่อ loop (B6) ให้ชื่อ tag เต็ม (B17–B20) ตรงกับที่ใช้ใน DataLink เช่น \\\\GCMPPISVR\\3-CTA.2M.3FC1301B.PV"),
        ("2", "แท็บ Setup ตาราง loop (แถว 36 ลงไป): ใส่ชื่อ loop, ชนิด, SL, SH, หน่วย (และ PB/TI/TD ถ้ารู้) ของ loop ที่จะดู ใส่ครั้งเดียวต่อ loop"),
        ("3", "แท็บ Data: คลิกเซลล์ A2 → PI DataLink → Sampled Data"),
        ("4", "Data item(s): ลากเลือก Data!B1:E1 · Start time: *-2h · End time: * · Time interval: 1s · ติ๊ก Show time stamps · Output cell: Data!A2 → OK"),
        ("5", "Save ไฟล์นี้ไว้ใช้ต่อ"),
        ("", ""),
        ("ครั้งต่อไป", None),
        ("1", "แท็บ Setup: เปลี่ยนชื่อ loop ที่ B6 (ถ้า loop ใหม่ยังไม่มีในตาราง ให้เพิ่มแถวในตาราง loop)"),
        ("2", "ถ้าข้อมูลไม่อัปเดตเอง: กด F9 หรือ PI DataLink → Update"),
        ("3", "ดูผลที่แท็บ Health: กล่องสรุปด้านบนบอกว่า loop ปกติ / ควรติดตาม / ควรแจ้ง engineer และควรทำอะไรต่อ"),
        ("4", "จะส่ง engineer: แท็บ Report → File → Print (หรือ Save as PDF)"),
        ("", ""),
        ("Tuning (ใช้เมื่อมี step test หรือ model จาก engineer)", None),
        ("•", "แท็บ Tuning: ส่วนที่ 1 ช่วยคำนวณ Kp, θ, τ จากค่าที่อ่านบน trend ของ DCS · ส่วนที่ 2 คำนวณ PB/TI/TD แนะนำ (หน่วย CENTUM)"),
        ("•", "ค่าที่ได้ใช้ประกอบการพิจารณาเท่านั้น ต้องผ่าน control engineer และ MOC ก่อนเปลี่ยนใน DCS"),
        ("", ""),
        ("หมายเหตุ", None),
        ("•", f"รองรับข้อมูลได้ {MAX_ROWS:,} แถว (เช่น 5.5 ชั่วโมงที่ 1 วินาที)"),
        ("•", "ถ้า DataLink ขึ้น \"Tag not found\" ที่ MODE ไม่เป็นไร ไฟล์จะถือว่าข้อมูลทั้งหมดเป็น closed-loop"),
        ("•", "ไฟล์นี้ไม่ตรวจ valve ติดอัตโนมัติ ให้ดูกราฟ OP vs PV และ trend 1 วินาทีบน DCS (MV เป็นฟันเลื่อยแต่ PV กระโดดเป็นขั้น = valve ติด)"),
        ("•", "ช่องสีเหลือง = ช่องที่แก้ได้ · ช่องอื่นเป็นสูตร ไม่ต้องแก้"),
    ]
    r = 3
    for a, b in steps:
        if b is None:
            cell(h, f"A{r}", a, bold)
        else:
            cell(h, f"A{r}", a)
            cell(h, f"B{r}", b, align=wrap)
        r += 1
    h.column_dimensions["A"].width = 10
    h.column_dimensions["B"].width = 110

    # ───────────────────────── Setup ─────────────────────────
    s = wb.create_sheet("Setup")
    cell(s, "A1", "ตั้งค่า", title)
    cell(s, "A2", "แก้เฉพาะช่องสีเหลือง ช่องอื่นคำนวณให้เอง", muted)
    rows = [
        (4, "PI server", loop.get("server", "GCMPPISVR"), "ชื่อ PI Data Server (ส่วน \\\\GCMPPISVR\\ ในชื่อ tag ของ DataLink)"),
        (5, "Area prefix", loop.get("area", "3-CTA.2M."), "ส่วนหน้าชื่อ tag ของพื้นที่นั้น (รวมจุดท้าย)"),
        (6, "Loop tag", loop.get("tag", "3FC1301B"), "ชื่อ loop เปลี่ยนช่องนี้ช่องเดียวเมื่อจะดู loop อื่น"),
        (7, "PV suffix", ".PV", "ถ้าชื่อ tag ใน PI ต่างจากนี้ แก้ได้"),
        (8, "SV suffix", ".SV", ""),
        (9, "MV suffix", ".MV", ""),
        (10, "MODE suffix", ".MODE", "ถ้าไม่มี tag MODE ใน PI ปล่อยไว้ได้"),
        (12, "Start time", "*-2h", "PI time: *-2h = ย้อนหลัง 2 ชั่วโมง"),
        (13, "End time", "*", "* = ตอนนี้"),
        (14, "Interval", "1s", "flow/pressure 1s · temperature 5s · level 1–5s"),
    ]
    for rr, label, val, note in rows:
        cell(s, f"A{rr}", label, bold)
        cell(s, f"B{rr}", val, blue, yellow, border=box)
        cell(s, f"C{rr}", note, muted)
    cell(s, "A16", "ชื่อ tag เต็ม (คำนวณให้)", bold)
    for i, (lab, ref) in enumerate([("PV", "B7"), ("SV", "B8"), ("MV", "B9"), ("MODE", "B10")]):
        rr = 17 + i
        cell(s, f"A{rr}", lab)
        cell(s, f"B{rr}", '="\\\\"&$B$4&"\\"&$B$5&$B$6&' + ref, border=box)
    name("Loop", "Setup!$B$6")

    # loop settings pulled from the loop table
    T0, T1 = 36, 36 + TAG_ROWS - 1
    cell(s, "A22", "ค่าของ loop นี้ (ดึงจากตาราง loop ด้านล่างตามชื่อใน B6)", bold)
    look = lambda col: f'IFERROR(IF(INDEX(${col}${T0}:${col}${T1},MATCH(Loop,$A${T0}:$A${T1},0))="","",INDEX(${col}${T0}:${col}${T1},MATCH(Loop,$A${T0}:$A${T1},0))),"")'
    settings = [
        (23, "ชนิด loop", "B", "LoopType"),
        (24, "PV range ต่ำ (SL)", "C", "SL"),
        (25, "PV range สูง (SH)", "D", "SH"),
        (26, "หน่วย PV", "E", "UnitPV"),
        (27, "PB ปัจจุบัน (%)", "F", "PBcur"),
        (28, "TI ปัจจุบัน (s)", "G", "TIcur"),
        (29, "TD ปัจจุบัน (s)", "H", "TDcur"),
    ]
    for rr, label, col, nm in settings:
        cell(s, f"A{rr}", label)
        cell(s, f"B{rr}", "=" + look(col), green, border=box)
        name(nm, f"Setup!$B${rr}")
    cell(s, "A30", "สถานะ", bold)
    cell(s, "B30", f'=IF(ISNA(MATCH(Loop,$A${T0}:$A${T1},0)),"⚠ ไม่พบ loop นี้ในตาราง ให้เพิ่มแถวด้านล่าง",IF(AND(ISNUMBER(SL),ISNUMBER(SH)),IF(SH>SL,"✓ พร้อมใช้","⚠ SH ต้องมากกว่า SL"),"⚠ ยังไม่ได้ใส่ SL/SH ในตาราง"))', bold)

    cell(s, "A34", "ตาราง loop (ใส่ครั้งเดียวต่อ loop · ชื่อ loop ต้องตรงกับที่ใส่ใน B6)", bold)
    heads = ["Loop tag", "ชนิด loop", "SL", "SH", "หน่วย", "PB (%)", "TI (s)", "TD (s)", "หมายเหตุ"]
    for i, hd in enumerate(heads):
        c = cell(s, f"{'ABCDEFGHI'[i]}35", hd, bold, head_fill, border=box)
    table = example_rows if example_rows is not None else [("3FC1301B", "flow", 0, 120, "m3/h", None, None, None, "ตัวอย่าง: flow ใน CAS กับ level controller")]
    if "table" in loop:
        table = loop["table"]
    for i in range(TAG_ROWS):
        rr = T0 + i
        vals = table[i] if i < len(table) else (None,) * 9
        for j, col in enumerate("ABCDEFGHI"):
            v = vals[j] if j < len(vals) else None
            cell(s, f"{col}{rr}", v, blue, yellow if col != "I" else None, border=box)
    dv = DataValidation(type="list", formula1='"' + ",".join(LOOP_TYPES) + '"', allow_blank=True)
    s.add_data_validation(dv)
    dv.add(f"B{T0}:B{T1}")
    s.column_dimensions["A"].width = 30
    s.column_dimensions["B"].width = 44
    s.column_dimensions["C"].width = 14
    for col in "DEFGH":
        s.column_dimensions[col].width = 12
    s.column_dimensions["I"].width = 40
    cell(s, "D17", "← ชื่อ tag ที่ DataLink ใช้ (แถว 1 ของแท็บ Data ดึงจากตรงนี้)", muted)

    # ───────────────────────── Data ─────────────────────────
    d = wb.create_sheet("Data")
    cell(d, "A1", "Timestamp", bold, head_fill, border=box)
    for col, rr in zip("BCDE", range(17, 21)):
        cell(d, f"{col}1", f"=Setup!$B${rr}", bold, head_fill, border=box)
    for col in "ABCDE":
        d.column_dimensions[col].width = 22 if col == "A" else 34
    d["A2"].comment = Comment("PI DataLink → Sampled Data ใส่ผลที่เซลล์นี้ (A2) ดูขั้นตอนในแท็บ HowTo", "PI Loop Health")
    cell(d, "G1", "← แถว 1 = ชื่อ tag (จากแท็บ Setup) · ข้อมูล PI DataLink เริ่มที่ A2", muted)
    cell(d, "G2", f'=IF(COUNTA(Data!A{R1 + 1}:A{R1 + 5})>0,"⚠ ข้อมูลเกิน {MAX_ROWS:,} แถว ส่วนเกินจะไม่ถูกวิเคราะห์ ลดช่วงเวลาใน Setup","")', Font(name=F, bold=True, color="C00000"))
    d.freeze_panes = "A2"
    for r in range(R0, R0 + len(data or [])):
        ts, pv, sv, mv, mode = data[r - R0]
        cell(d, f"A{r}", ts, fmt="dd-mmm-yy hh:mm:ss")
        d[f"B{r}"] = pv
        d[f"C{r}"] = sv
        d[f"D{r}"] = mv
        d[f"E{r}"] = mode
    if not data:
        d["A2"].number_format = "dd-mmm-yy hh:mm:ss"
    for r in range(R0, R1 + 1):
        d[f"A{r}"].number_format = "dd-mmm-yy hh:mm:ss"

    # ───────────────────────── Calc ─────────────────────────
    c = wb.create_sheet("Calc")
    heads = {
        "A": "t (s)", "B": "ข้อมูลครบ", "C": "PV %span", "D": "SP %span", "E": "closed-loop", "F": "error %span",
        "G": "OP ≤2%", "H": "OP ≥98%", "I": "ΔPV", "J": "ค่าซ้ำ", "K": "เส้นตรง", "L": "error − ค่าเฉลี่ย",
    }
    for col, hd in heads.items():
        cell(c, f"{col}1", hd, bold, head_fill)
    for r in range(R0, R1 + 1):
        p = r - 1
        c[f"A{r}"] = f'=IF(ISNUMBER(Data!A{r}),(Data!A{r}-Data!$A${R0})*86400,"")'
        c[f"B{r}"] = f"=AND(ISNUMBER(Data!B{r}),ISNUMBER(Data!D{r}))"
        c[f"C{r}"] = f'=IF(AND(B{r},RangeOK),(Data!B{r}-SL)/(SH-SL)*100,"")'
        c[f"D{r}"] = f'=IF(AND(B{r},RangeOK,ISNUMBER(Data!C{r})),(Data!C{r}-SL)/(SH-SL)*100,"")'
        c[f"E{r}"] = f'=IF(B{r},IF(ModeUsable,OR(ISNUMBER(SEARCH("AUT",Data!E{r})),ISNUMBER(SEARCH("CAS",Data!E{r}))),TRUE),FALSE)'
        c[f"F{r}"] = f'=IF(AND(E{r},ISNUMBER(C{r}),ISNUMBER(D{r})),D{r}-C{r},"")'
        c[f"G{r}"] = f'=IF(E{r},IF(Data!D{r}<=2,1,0),"")'
        c[f"H{r}"] = f'=IF(E{r},IF(Data!D{r}>=98,1,0),"")'
        if r == R0:
            c[f"I{r}"] = '=""'
            c[f"J{r}"] = '=""'
            c[f"K{r}"] = '=""'
        else:
            c[f"I{r}"] = f'=IF(AND(ISNUMBER(C{r}),ISNUMBER(C{p})),C{r}-C{p},"")'
            if r < R1:
                n_ = r + 1
                c[f"J{r}"] = f'=IF(AND(ISNUMBER(Data!B{p}),ISNUMBER(Data!B{r}),ISNUMBER(Data!B{n_})),IF(ABS(Data!B{r}-Data!B{p})<=Tol,1,0),"")'
                c[f"K{r}"] = f'=IF(ISNUMBER(J{r}),IF(AND(J{r}=0,ABS(Data!B{n_}-2*Data!B{r}+Data!B{p})<=Tol*10),1,0),"")'
            else:
                c[f"J{r}"] = '=""'
                c[f"K{r}"] = '=""'
        c[f"L{r}"] = f"=IF(AND(ISNUMBER(F{r}),ISNUMBER(ErrMean)),F{r}-ErrMean,0)"

    # oscillation (same idea as the web app, Thornhill 2003): autocorrelation of the demeaned error
    # at NL lag points (step = Step samples, up to half the data), 3-point smoothing, zero crossings,
    # regularity of the crossing intervals and height of the first ACF peak.
    NL = 600
    for col, hd in zip(["AF", "AG", "AH", "AI", "AJ", "AK", "AL"], ["j", "lag (จุด)", "ACF", "ACF เรียบ", "ตัดศูนย์", "lag ที่ตัด", "นับสะสม"]):
        cell(c, f"{col}1", hd, bold, head_fill)
    Lr = f"$L${R0}:$L${R1}"
    for j in range(NL):
        rr = j + 2
        c[f"AF{rr}"] = j
        c[f"AG{rr}"] = f"=AF{rr}*Step"
        c[f"AH{rr}"] = (f'=IF(AND(AcfC0>0,AG{rr}<Nd-1),SUMPRODUCT(INDEX({Lr},1):INDEX({Lr},Nd-AG{rr}),'
                        f'INDEX({Lr},1+AG{rr}):INDEX({Lr},Nd))/AcfC0,"")')
        if j == 0 or j == NL - 1:
            c[f"AI{rr}"] = f"=AH{rr}"
        else:
            c[f"AI{rr}"] = f'=IF(AND(ISNUMBER(AH{rr - 1}),ISNUMBER(AH{rr}),ISNUMBER(AH{rr + 1})),(AH{rr - 1}+AH{rr}+AH{rr + 1})/3,AH{rr})'
        if j == 0:
            c[f"AJ{rr}"] = 0
            c[f"AK{rr}"] = '=""'
            c[f"AL{rr}"] = 0
        else:
            c[f"AJ{rr}"] = f"=IF(AND(ISNUMBER(AI{rr - 1}),ISNUMBER(AI{rr})),IF((AI{rr - 1}>0)<>(AI{rr}>0),1,0),0)"
            c[f"AK{rr}"] = f'=IF(AJ{rr}=1,(AF{rr - 1}+AI{rr - 1}/(AI{rr - 1}-AI{rr}))*Step,"")'
            c[f"AL{rr}"] = f"=AL{rr - 1}+AJ{rr}"
    for col, hd in zip(["AN", "AO", "AP"], ["ครั้งที่", "lag ที่ตัดศูนย์", "คาบ (จุด)"]):
        cell(c, f"{col}1", hd, bold, head_fill)
    for k in range(1, 13):
        rr = k + 1
        c[f"AN{rr}"] = k
        c[f"AO{rr}"] = f'=IFERROR(INDEX($AK$2:$AK${NL + 1},MATCH(AN{rr},$AL$2:$AL${NL + 1},0)),"")'
        c[f"AP{rr}"] = f'=IF(AND(ISNUMBER(AO{rr}),ISNUMBER(AO{rr + 2})),AO{rr + 2}-AO{rr},"")' if k <= 10 else '=""'

    # metrics (Calc!V:W) — each gets a workbook name
    A = lambda col: f"Calc!${col}${R0}:${col}${R1}"
    metrics = [
        ("N_ok", "จำนวนจุดที่ใช้ได้", f"=COUNTIF({A('B')},TRUE)"),
        ("RangeOK", "SL/SH ใช้ได้", "=AND(ISNUMBER(SL),ISNUMBER(SH),SH>SL)"),
        ("DT", "sample interval (s)", f"=IF(COUNT({A('A')})>1,(MAX({A('A')})-MIN({A('A')}))/(COUNT({A('A')})-1),1)"),
        ("ModeUsable", "มี MODE ที่ใช้ได้", f'=(COUNTIF({rng("E")},"*AUT*")+COUNTIF({rng("E")},"*CAS*")+COUNTIF({rng("E")},"*MAN*"))>0'),
        ("PctAuto", "% เวลาใน AUTO/CAS", f'=IF(AND(ModeUsable,N_ok>0),COUNTIFS({A("E")},TRUE)/N_ok*100,"")'),
        ("HasSP", "มี SP", f"=COUNT({A('D')})>10"),
        ("AllMan", "MAN ทั้งช่วง", "=AND(ModeUsable,N_ok>0,N(PctAuto)=0)"),
        ("ErrStd", "error std (%span)", f'=IF(COUNT({A("F")})>10,STDEV({A("F")}),"")'),
        ("ErrMean", "error เฉลี่ย (%span)", f'=IF(COUNT({A("F")})>10,AVERAGE({A("F")}),"")'),
        ("OpLowPct", "% OP ≤ 2%", f'=IF(COUNT({A("G")})>10,SUM({A("G")})/COUNT({A("G")})*100,"")'),
        ("OpHighPct", "% OP ≥ 98%", f'=IF(COUNT({A("H")})>10,SUM({A("H")})/COUNT({A("H")})*100,"")'),
        ("OpMean", "OP เฉลี่ย (%)", f'=IFERROR(AVERAGEIFS({rng("D")},{A("E")},TRUE),"")'),
        ("Noise", "PV noise (%span)", f'=IF(COUNT({A("I")})>2,STDEV({A("I")})/SQRT(2),"")'),
        ("Tol", "tolerance", f'=MAX(1E-12,(MAX({rng("B")})-MIN({rng("B")}))*1E-7)'),
        ("FlatFrac", "สัดส่วนค่าซ้ำ", f'=IF(COUNT({A("J")})>0,SUM({A("J")})/COUNT({A("J")}),0)'),
        ("LinFrac", "สัดส่วนเส้นตรง", f'=IF(COUNT({A("K")})>0,SUM({A("K")})/COUNT({A("K")}),0)'),
        ("Compressed", "ข้อมูลถูก compress", "=OR(FlatFrac>0.3,LinFrac>0.3)"),
        ("PvStd", "PV std (%span)", f'=IF(COUNT({A("C")})>2,STDEV({A("C")}),0)'),
        ("SpStd", "SP std (%span)", f'=IF(COUNT({A("D")})>2,STDEV({A("D")}),0)'),
        ("SpMoving", "SP ขยับตลอด", "=AND(HasSP,PvStd>0,SpStd>=0.5*PvStd,SpStd>0.05)"),
        ("Nd", "จำนวนแถวข้อมูล", f"=COUNT({A('A')})"),
        ("Step", "ระยะห่าง lag (จุด)", f"=MAX(1,CEILING(Nd/2/{NL},1))"),
        ("AcfC0", "ACF c(0)", f"=SUMPRODUCT({A('L')},{A('L')})"),
        ("NZC", "จำนวนจุดตัดศูนย์ของ ACF", f"=MIN(12,MAX(Calc!$AL$2:$AL${NL + 1}))"),
        ("NPer", "จำนวนคาบที่วัดได้", "=COUNT(Calc!$AP$2:$AP$11)"),
        ("MeanLag", "คาบเฉลี่ย (จุด)", '=IF(NPer>0,AVERAGE(Calc!$AP$2:$AP$11),"")'),
        ("StdLag", "std ของคาบ (จุด)", '=IF(NPer>1,STDEV(Calc!$AP$2:$AP$11),"")'),
        ("MeanP", "คาบเฉลี่ย (s)", '=IF(ISNUMBER(MeanLag),MeanLag*DT,"")'),
        ("Regularity", "regularity (>1 = สม่ำเสมอ)", '=IF(NPer>1,IF(StdLag>0,MeanLag/(3*StdLag),99),0)'),
        ("AcfPeak", "ความสูงยอด ACF แรก", f'=IF(NZC>=3,_xlfn.MAXIFS(Calc!$AH$2:$AH${NL + 1},Calc!$AG$2:$AG${NL + 1},">="&Calc!$AO$3,Calc!$AG$2:$AG${NL + 1},"<="&Calc!$AO$4),0)'),
        ("Oscillating", "แกว่งเป็นจังหวะ", "=AND(N_ok>=50,NZC>=4,Regularity>1,AcfPeak>0.2)"),
    ]
    cell(c, "V1", "ตัวชี้วัด", bold, head_fill)
    cell(c, "W1", "ค่า", bold, head_fill)
    for i, (nm, label, f) in enumerate(metrics):
        rr = i + 2
        cell(c, f"V{rr}", label)
        c[f"W{rr}"] = f
        name(nm, f"Calc!$W${rr}")
    c.column_dimensions["V"].width = 26
    c.column_dimensions["W"].width = 14
    c.freeze_panes = "A2"
    cell(c, "Y1", "สูตรช่วยคำนวณ ไม่ต้องแก้", muted)

    # ───────────────────────── Health ─────────────────────────
    hs = wb.create_sheet("Health", 1)
    cell(hs, "A1", '="สุขภาพ Loop: "&Loop', title)
    cell(hs, "A2", f'=IF(N_ok>0,"ข้อมูล "&TEXT(MIN({rng("A")}),"dd/mm/yyyy hh:mm")&" → "&TEXT(MAX({rng("A")}),"dd/mm/yyyy hh:mm")&" · "&TEXT(N_ok,"#,##0")&" จุด · ทุก "&TEXT(DT,"0.##")&" s · PV range "&SL&" – "&SH&" "&UnitPV,"ยังไม่มีข้อมูลในแท็บ Data (ดูวิธีดึงข้อมูลในแท็บ HowTo)")', muted)
    cell(hs, "A3", "=Setup!B30", bold)

    # summary conditions → level (0 good, 1 warn, 2 bad), parts of the sentence, actions
    period_txt = 'IF(MeanP<120,TEXT(MeanP,"0")&" วินาที",IF(MeanP<7200,TEXT(MeanP/60,"0.0")&" นาที",TEXT(MeanP/3600,"0.0")&" ชม."))'
    sat_sum = "(OpLowPct+OpHighPct)"
    conds = [
        # key, condition, level formula, sentence part, action
        ("range", "NOT(RangeOK)", "1", '"ยังไม่ได้ตั้ง SL/SH"', '"ใส่ชื่อ loop, ชนิด, SL, SH ในตาราง loop ของแท็บ Setup (ตอนนี้ตัวเลข %span ยังคำนวณไม่ได้)"'),
        ("osc_cas", "AND(Oscillating,SpMoving)", "1", f'"loop แกว่งเป็นจังหวะ คาบประมาณ "&{period_txt}&" และ SP ขยับตลอด (น่าจะอยู่ใน CAS/APC)"',
         '"SP ถูกสั่งจาก loop อื่น ให้ดึงข้อมูล loop ต้นทางช่วงเวลาเดียวกันมาดู ถ้าแกว่งคาบเท่ากัน แปลว่าแกว่งทั้ง cascade"'),
        ("osc", "AND(Oscillating,NOT(SpMoving))", "2", f'"loop แกว่งเป็นจังหวะ คาบประมาณ "&{period_txt}',
         '"แจ้ง control engineer พร้อม report นี้ เพื่อหาต้นเหตุ (tuning แรงเกิน, valve ติด หรือ loop อื่นแกว่งมารบกวน)"'),
        ("osc_valve", 'AND(Oscillating,OR(LoopType="flow",LoopType="pressure"))', "0", '""',
         '"แยก valve ติดกับ tuning: ดู trend 1 วินาทีบน DCS ถ้า MV เป็นฟันเลื่อย แต่ PV กระโดดเป็นขั้น = valve ติด ให้แจ้ง instrument ตรวจ valve"'),
        ("sat", f"AND(ISNUMBER(OpLowPct),{sat_sum}>=5)", f"IF({sat_sum}>=20,2,1)", '"OP ติดขอบบ่อย"',
         '"valve เปิดสุดหรือปิดสุดบ่อย ตรวจขนาด valve, bypass หรือ SP ที่เป็นไปไม่ได้"'),
        ("offset", "AND(ISNUMBER(ErrMean),ABS(ErrMean)>1)", "1", '"PV มี offset ค้างจาก SP"', '""'),
        ("allman", "AND(ModeUsable,ISNUMBER(PctAuto),PctAuto=0)", "0", '"ช่วงเวลานี้ loop อยู่ใน MAN ทั้งหมด จึงประเมิน closed-loop ไม่ได้"',
         '"เลือกช่วงเวลาที่ loop อยู่ใน AUTO/CAS (แก้ Start/End time ในแท็บ Setup) · ถ้าช่วงนี้เป็น step test ให้อ่านค่า Kp, θ, τ ไปใช้ในแท็บ Tuning"'),
        ("auto", "AND(ModeUsable,ISNUMBER(PctAuto),PctAuto>0,PctAuto<90)", "IF(PctAuto<70,2,1)", '"loop ถูกเปลี่ยนเป็น MAN บ่อย"',
         '"ถาม operator ว่าทำไมต้องเปลี่ยนเป็น MAN (tuning, valve หรือ process upset)"'),
        ("err", "AND(NOT(Oscillating),ISNUMBER(ErrStd),ErrStd>=1)", "1", '"PV ห่าง SP ค่อนข้างมาก แต่ไม่ได้แกว่งเป็นจังหวะ"',
         '"ดูว่ามี disturbance จาก process หรือ SP เปลี่ยนบ่อย ถ้าเกิดต่อเนื่องให้ engineer พิจารณา tuning"'),
        ("comp", "Compressed", "0", '""', '"ข้อมูลถูก PI compress ผลบางข้อเชื่อได้น้อย ดู trend 1 วินาทีบน DCS ประกอบ"'),
    ]
    # helper table on Calc (Y:AD): active flag, level, part, action, action rank
    for col, hd in zip(["Y", "Z", "AA", "AB", "AC", "AD"], ["เงื่อนไข", "เข้าเงื่อนไข", "ระดับ", "ข้อความ", "สิ่งที่ควรทำ", "ลำดับ"]):
        cell(c, f"{col}2", hd, bold, head_fill)
    for i, (key, cond, lvl, part, act) in enumerate(conds):
        rr = 3 + i
        c[f"Y{rr}"] = key
        c[f"Z{rr}"] = f"=IF(N_ok<10,FALSE,IFERROR({cond},FALSE))" if key != "range" else f"=IFERROR({cond},TRUE)"
        c[f"AA{rr}"] = f"=IF(Z{rr},IFERROR({lvl},0),0)"
        c[f"AB{rr}"] = f'=IF(Z{rr},IFERROR({part},""),"")'
        c[f"AC{rr}"] = f'=IF(Z{rr},IFERROR({act},""),"")'
        c[f"AD{rr}"] = f'=IF(AC{rr}<>"",COUNTIF(AC$3:AC{rr},"?*"),"")'
    ce = 3 + len(conds) - 1
    name("Level", f"Calc!$AA${ce + 2}")
    c[f"Z{ce + 2}"] = "ระดับรวม"
    c[f"AA{ce + 2}"] = f"=MAX(AA3:AA{ce})"
    name("SumText", f"Calc!$AB${ce + 2}")
    c[f"AB{ce + 2}"] = f'=IF(N_ok<10,"ยังไม่มีข้อมูล",IF(_xlfn.TEXTJOIN(" · ",TRUE,AB3:AB{ce})="","ไม่พบปัญหาในช่วงข้อมูลนี้",_xlfn.TEXTJOIN(" · ",TRUE,AB3:AB{ce})))'
    name("NAct", f"Calc!$AD${ce + 2}")
    c[f"AD{ce + 2}"] = f"=COUNT(AD3:AD{ce})"

    cell(hs, "A5", "สรุป", big)
    cell(hs, "A6", '=IF(N_ok<10,"–  ยังไม่มีข้อมูล",IF(Level=2,"✕  ควรแจ้ง engineer",IF(Level=1,"!  ควรติดตาม",IF(AllMan,"–  ประเมินไม่ได้ (อยู่ใน MAN ทั้งช่วง)","✓  ปกติ"))))', Font(name=F, bold=True, size=16))
    cell(hs, "A7", "=SumText", Font(name=F, size=12))
    hs.row_dimensions[7].height = 22
    cell(hs, "A8", "ควรทำอะไรต่อ", bold)
    act_rows = range(9, 15)
    cal_act = f"Calc!$AC$3:$AC${ce}"
    cal_rank = f"Calc!$AD$3:$AD${ce}"
    for k, rr in enumerate(act_rows, start=1):
        first = f'IF(AND(N_ok>=10,NAct=0,{k}=1),"ไม่ต้องทำอะไรเพิ่ม ตรวจซ้ำเป็นระยะได้","")'
        cell(hs, f"A{rr}", f'=IFERROR("{k}. "&INDEX({cal_act},MATCH({k},{cal_rank},0)),{first})')
        hs.row_dimensions[rr].height = 20
    for key, color in (("2", "bad"), ("1", "warn"), ("0", "good")):
        hs.conditional_formatting.add("A6:D14", FormulaRule(formula=[f"AND(N_ok>=10,Level={key},OR(Level>0,NOT(AllMan)))"], fill=FILL[color]))

    # findings table
    cell(hs, "A16", "ผลการตรวจ", big)
    for j, hd in enumerate(["หัวข้อ", "ค่า", "สถานะ", "ความหมาย"]):
        cell(hs, f"{'ABCD'[j]}17", hd, bold, head_fill, border=box)
    st = lambda good, warn: f'IF({good},"ปกติ",IF({warn},"ควรตรวจ","มีปัญหา"))'
    findings = [
        ("เวลาอยู่ใน AUTO/CAS",
         'IF(ModeUsable,TEXT(PctAuto,"0.0")&"%","—")',
         f'IF(NOT(ModeUsable),"ไม่มีข้อมูล",IF(PctAuto=0,"ข้อมูล",{st("PctAuto>=90", "PctAuto>=70")}))',
         'IF(NOT(ModeUsable),"ไม่มี MODE ที่ใช้ได้ จึงถือว่าข้อมูลทั้งหมดเป็น closed-loop",IF(PctAuto=0,"อยู่ใน MAN ทั้งช่วง (เช่นระหว่าง step test)",IF(PctAuto>=90,"loop อยู่ใน AUTO/CAS เกือบตลอด","loop ถูกเปลี่ยนเป็น MAN บ่อย ถาม operator ว่าเพราะอะไร")))'),
        ("คุณภาพข้อมูล",
         'TEXT(LinFrac*100,"0")&"% เส้นตรง · "&TEXT(FlatFrac*100,"0")&"% ค่าซ้ำ"',
         'IF(Compressed,"ควรตรวจ","ปกติ")',
         'IF(Compressed,"ข้อมูลเป็นค่าที่ PI เติมเส้นตรงระหว่างจุดที่เก็บจริง (compression) ผล noise เชื่อไม่ได้ ดู trend 1 วินาทีบน DCS ประกอบ","ข้อมูลละเอียดพอ")'),
        ("SP / SV",
         'IF(NOT(HasSP),"—",IF(SpMoving,"ขยับตลอดช่วง","คงที่ส่วนใหญ่"))',
         'IF(NOT(HasSP),"ไม่มีข้อมูล","ข้อมูล")',
         'IF(NOT(HasSP),"ไม่มีข้อมูล SV",IF(SpMoving,"SP ถูกเปลี่ยนตลอด น่าจะอยู่ใน CAS หรือ APC การแกว่งอาจมาจาก loop ต้นทาง","SP ไม่ได้เปลี่ยนมาก"))'),
        ("Error (SP−PV) std",
         'IF(ISNUMBER(ErrStd),TEXT(ErrStd,"0.00")&" %span ("&TEXT(ErrStd*(SH-SL)/100,"0.00")&" "&UnitPV&")","—")',
         f'IF(NOT(ISNUMBER(ErrStd)),"ไม่มีข้อมูล",{st("ErrStd<1", "ErrStd<3")})',
         'IF(NOT(ISNUMBER(ErrStd)),"ไม่มี SV หรือข้อมูลน้อยเกินไป",IF(ErrStd<1,"PV อยู่ใกล้ SP ดี","PV แกว่งห่าง SP ค่อนข้างมาก"))'),
        ("Offset เฉลี่ย",
         'IF(ISNUMBER(ErrMean),TEXT(ErrMean,"0.00")&" %span","—")',
         'IF(NOT(ISNUMBER(ErrMean)),"ไม่มีข้อมูล",IF(ABS(ErrMean)<=1,"ปกติ","ควรตรวจ"))',
         'IF(NOT(ISNUMBER(ErrMean)),"",IF(ABS(ErrMean)<=1,"ไม่มี offset ค้าง","มี offset ค้าง ถ้า OP ติดขอบแสดงว่า valve สุดแล้ว"))'),
        ("OP ติดขอบ (≤2% / ≥98%)",
         'IF(ISNUMBER(OpLowPct),TEXT(OpLowPct,"0.0")&"% / "&TEXT(OpHighPct,"0.0")&"%","—")',
         f'IF(NOT(ISNUMBER(OpLowPct)),"ไม่มีข้อมูล",{st("(OpLowPct+OpHighPct)<5", "(OpLowPct+OpHighPct)<20")})',
         'IF(NOT(ISNUMBER(OpLowPct)),"",IF((OpLowPct+OpHighPct)<5,"OP มีช่วงให้ขยับพอ","OP ติดขอบบ่อย ช่วงนั้น loop คุมไม่ได้"))'),
        ("OP เฉลี่ย",
         'IF(ISNUMBER(OpMean),TEXT(OpMean,"0.0")&"%","—")',
         'IF(NOT(ISNUMBER(OpMean)),"ไม่มีข้อมูล",IF(OR(OpMean<10,OpMean>90),"ควรตรวจ","ปกติ"))',
         'IF(NOT(ISNUMBER(OpMean)),"",IF(OR(OpMean<10,OpMean>90),"OP เฉลี่ยใกล้ขอบมาก valve อาจ oversize/undersize","OP อยู่ในช่วงทำงานปกติ"))'),
        ("PV noise",
         'IF(AND(ISNUMBER(Noise),NOT(Compressed)),TEXT(Noise,"0.000")&" %span","—")',
         f'IF(OR(Compressed,NOT(ISNUMBER(Noise))),"ไม่มีข้อมูล",{st("Noise<0.2", "Noise<1")})',
         'IF(Compressed,"ประเมินไม่ได้ เพราะข้อมูลถูก compress",IF(NOT(ISNUMBER(Noise)),"",IF(Noise<0.2,"noise ต่ำ","noise สูง ไม่ควรใช้ TD และระวัง gain สูง")))'),
        ("การแกว่ง (oscillation)",
         f'IF(N_ok<50,"—",IF(Oscillating,"คาบ ≈ "&{period_txt}&" (r = "&TEXT(Regularity,"0.0")&")",IF(NPer>1,"ไม่สม่ำเสมอ (r = "&TEXT(Regularity,"0.0")&")","ไม่พบ")))',
         'IF(N_ok<50,"ไม่มีข้อมูล",IF(Oscillating,"มีปัญหา","ปกติ"))',
         'IF(N_ok<50,"ข้อมูลน้อยเกินไป (ต้องมีอย่างน้อย 50 จุด)",IF(Oscillating,"แกว่งอย่างสม่ำเสมอ อาจมาจาก tuning แรงเกิน, valve ติด หรือ loop อื่นที่แกว่งมารบกวน","ไม่พบการแกว่งที่เป็นคาบชัดเจน"))'),
        ("Valve ติด (stiction)",
         '"ไม่ได้ตรวจอัตโนมัติ"',
         '"ข้อมูล"',
         '"ดูกราฟ OP vs PV ด้านล่าง: รูปสี่เหลี่ยมด้านขนาน = สงสัย valve ติด · ยืนยันด้วย trend 1 วินาทีบน DCS หรือ valve test"'),
    ]
    for i, (label, val, stat, msg) in enumerate(findings):
        rr = 18 + i
        cell(hs, f"A{rr}", label, bold, border=box)
        cell(hs, f"B{rr}", f'=IF(N_ok<10,"—",IFERROR({val},"—"))', border=box)
        cell(hs, f"C{rr}", f'=IF(N_ok<10,"ไม่มีข้อมูล",IFERROR({stat},"ไม่มีข้อมูล"))', bold, border=box)
        cell(hs, f"D{rr}", f'=IF(N_ok<10,"",IFERROR({msg},""))', border=box, align=wrap)
        hs.row_dimensions[rr].height = 30
    fr1 = 18 + len(findings) - 1
    status_rules(hs, f"C18:C{fr1}", "C18")
    hs.column_dimensions["A"].width = 26
    hs.column_dimensions["B"].width = 34
    hs.column_dimensions["C"].width = 14
    hs.column_dimensions["D"].width = 80

    # charts
    def trend_chart(ws, anchor, cols, titles, ytitle, height=7.5):
        ch = ScatterChart()
        ch.style = 13
        ch.height = height
        ch.width = 30
        ch.y_axis.title = ytitle
        ch.x_axis.number_format = "hh:mm"
        ch.legend.position = "b"
        xref = Reference(d, min_col=1, min_row=R0, max_row=R1)
        colors = {"B": "2A78D6", "C": "52514E", "D": "EB6834"}
        for col, ttl in zip(cols, titles):
            ci = " ABCDE".index(col)
            yref = Reference(d, min_col=ci, min_row=R0, max_row=R1)
            se = Series(yref, xref, title=ttl)
            se.marker.symbol = "none"
            se.smooth = False
            se.graphicalProperties.line.width = 15000
            se.graphicalProperties.line.solidFill = colors[col]
            if col == "C":
                se.graphicalProperties.line.dashStyle = "dash"
            ch.series.append(se)
        ch.x_axis.delete = False
        ch.y_axis.delete = False
        ws.add_chart(ch, anchor)

    def xy_chart(ws, anchor):
        ch = ScatterChart()
        ch.style = 13
        ch.height = 9
        ch.width = 14
        ch.title = "OP vs PV"
        ch.x_axis.title = "OP / MV (%)"
        ch.y_axis.title = "PV"
        ch.legend = None
        xref = Reference(d, min_col=4, min_row=R0, max_row=R1)
        yref = Reference(d, min_col=2, min_row=R0, max_row=R1)
        se = Series(yref, xref, title="OP vs PV")
        se.marker.symbol = "none"
        se.graphicalProperties.line.width = 6000
        se.graphicalProperties.line.solidFill = "2A78D6"
        ch.series.append(se)
        ch.x_axis.delete = False
        ch.y_axis.delete = False
        ws.add_chart(ch, anchor)

    cr = fr1 + 3
    cell(hs, f"A{cr - 1}", "Trend", big)
    trend_chart(hs, f"A{cr}", "BC", ["PV", "SP"], "PV / SP")
    trend_chart(hs, f"A{cr + 16}", "D", ["MV"], "MV (%)", height=6)
    xy_chart(hs, f"A{cr + 29}")
    cell(hs, f"C{cr + 29}", "วิธีอ่าน OP vs PV: ถ้าเป็นรูปสี่เหลี่ยมด้านขนาน (OP ขยับแต่ PV ไม่ขยับ แล้วกระโดด) = ลักษณะ valve ติด · ถ้าเป็นวงรีเรียบๆ มักมาจาก tuning หรือ disturbance", muted, align=wrap)
    hs.merge_cells(f"C{cr + 29}:D{cr + 32}")

    # ───────────────────────── Tuning ─────────────────────────
    tu = wb.create_sheet("Tuning", 2)
    tuning = tuning or {}
    cell(tu, "A1", "Tuning (ใช้เมื่อมี step test หรือ model จาก engineer)", title)
    cell(tu, "A2", "ค่าที่แนะนำใช้ประกอบการพิจารณาเท่านั้น ต้องผ่าน control engineer และ MOC ก่อนเปลี่ยนใน DCS · ควรเปลี่ยนทีละขั้นและเฝ้าดู loop", Font(name=F, bold=True, color="C00000"))
    cell(tu, "A4", "1) ตัวช่วยอ่าน step test จาก trend DCS (ช่องสีเหลือง)", big)
    inputs1 = [
        (5, "MV ก่อน step (%)", "mv0"), (6, "MV หลัง step (%)", "mv1"),
        (7, "PV ก่อน step (หน่วยจริง)", "pv0"), (8, "PV หลังนิ่ง (หน่วยจริง)", "pv1"),
        (9, "เวลาที่ขยับ MV (s)", "t0"), (10, "เวลาที่ PV เริ่มขยับ (s)", "t1"), (11, "เวลาที่ PV ถึงค่า 63% (s)", "t2"),
    ]
    for rr, label, key in inputs1:
        cell(tu, f"A{rr}", label)
        cell(tu, f"B{rr}", tuning.get(key), blue, yellow, border=box)
    cell(tu, "C11", '=IF(AND(ISNUMBER(B7),ISNUMBER(B8)),"← ค่า PV ที่ 63% = "&TEXT(B7+0.63*(B8-B7),"0.###"),"")', muted)
    out1 = [
        (13, "ΔMV (%)", "=IF(AND(ISNUMBER(B5),ISNUMBER(B6)),B6-B5,\"\")"),
        (14, "ΔPV (%span)", '=IF(AND(ISNUMBER(B7),ISNUMBER(B8),RangeOK),(B8-B7)/(SH-SL)*100,"")'),
        (15, "Kp (%span/%MV)", '=IFERROR(B14/B13,"")'),
        (16, "θ dead time (s)", '=IF(AND(ISNUMBER(B9),ISNUMBER(B10)),B10-B9,"")'),
        (17, "τ time constant (s)", '=IF(AND(ISNUMBER(B10),ISNUMBER(B11)),B11-B10,"")'),
    ]
    for rr, label, f in out1:
        cell(tu, f"A{rr}", label)
        cell(tu, f"B{rr}", f, green, border=box, fmt="0.###")

    cell(tu, "A19", "2) คำนวณ PB / TI / TD", big)
    inputs2 = [
        (20, "ชนิด model", tuning.get("model", "FOPDT"), "FOPDT = PV ขยับแล้วไปนิ่งค่าใหม่ (flow, pressure, temperature, analyzer) · Integrating = level"),
        (21, "Kp (%span/%MV)", tuning.get("Kp", "=B15"), "ค่าเริ่มต้นดึงจากส่วนที่ 1 พิมพ์ทับได้"),
        (22, "τ (s)", tuning.get("tau", "=B17"), ""),
        (23, "θ (s)", tuning.get("theta", "=B16"), ""),
        (24, "Ki (%span/s/%MV)", tuning.get("Ki"), "สำหรับ level เท่านั้น"),
        (25, "Control period (s)", tuning.get("Ts", 1), "ค่า scan period ของ PID block บน CENTUM"),
        (26, "วิธีคำนวณ", tuning.get("method", "อัตโนมัติ"), "อัตโนมัติ = เลือกตามชนิด loop"),
        (27, "ความแรง", tuning.get("aggr", "ปกติ"), "นุ่มนวล = ช้าแต่ทนต่อ model ผิดพลาด · เร็ว = ตอบสนองไวแต่เสี่ยงแกว่ง"),
        (28, "λ กำหนดเอง (s)", tuning.get("lam"), "เว้นว่าง = คำนวณให้"),
    ]
    for rr, label, val, note in inputs2:
        cell(tu, f"A{rr}", label)
        cell(tu, f"B{rr}", val, blue, yellow, border=box)
        cell(tu, f"C{rr}", note, muted)
    for ref, opts in (("B20", ["FOPDT", "Integrating"]), ("B26", METHODS), ("B27", ["นุ่มนวล", "ปกติ", "เร็ว"])):
        v = DataValidation(type="list", formula1='"' + ",".join(opts) + '"', allow_blank=False)
        tu.add_data_validation(v)
        v.add(ref)
    calc2 = [
        (30, "θ รวมครึ่ง control period (s)", "=B23+B25/2", "th"),
        (31, "θ สำหรับ λ (s)", "=MAX(B30,B25)", "thd"),
        (32, "วิธีที่ใช้", '=IF(B26="อัตโนมัติ",IF(B20="Integrating","Lambda averaging level",IF(LoopType="flow","Lambda",IF(OR(LoopType="temperature",LoopType="analyzer"),IF(B23/B22>0.3,"IMC-PID","SIMC"),"SIMC"))),B26)', "meth"),
        (33, "λ แนะนำ (s)", '=IF(B20="Integrating",MAX(10*B31,2/ABS(B24)),IF(LoopType="flow",MAX(B22,B31),IF(OR(LoopType="temperature",LoopType="analyzer"),MAX(B31,0.25*B22),MAX(B31,0.2*B22))))', "lamd"),
        (34, "ตัวคูณความแรง", '=IF(B27="นุ่มนวล",2,IF(B27="เร็ว",0.5,1))', "mult"),
        (35, "λ ที่ใช้ (s)", "=IF(ISNUMBER(B28),B28,B33*B34)", "lam"),
        (36, "|gain|", '=ABS(IF(B20="Integrating",B24,B21))', "K"),
        (37, "model ตรงกับวิธี", '=IF(B20="Integrating",OR(B32="Lambda averaging level",B32="SIMC tight level"),AND(B32<>"Lambda averaging level",B32<>"SIMC tight level"))', "ok"),
        (38, "Kc (%MV/%span)", '=IF(NOT(B37),"",IF(B32="Lambda",B22/(B36*(B35+B30)),IF(B32="SIMC",B22/(B36*(B35+B30)),IF(B32="IMC-PID",(B22+B30/2)/(B36*(B35+B30/2)),IF(B32="SIMC tight level",1/(B36*(B35+B30)),IF(B32="Lambda averaging level",(2*B35+B30)/(B36*(B35+B30)^2),""))))))', "Kc"),
        (39, "TI (s)", '=IF(NOT(B37),"",IF(B32="Lambda",B22,IF(B32="SIMC",MIN(B22,4*(B35+B30)),IF(B32="IMC-PID",B22+B30/2,IF(B32="SIMC tight level",4*(B35+B30),IF(B32="Lambda averaging level",2*B35+B30,""))))))', "Ti"),
        (40, "TD (s)", '=IF(NOT(B37),"",IF(B32="IMC-PID",B22*B30/(2*B22+B30),0))', "Td"),
    ]
    for rr, label, f, _ in calc2:
        cell(tu, f"A{rr}", label, muted)
        cell(tu, f"B{rr}", f"=IFERROR({f[1:]},\"\")" if f.startswith("=") else f, fmt="0.####")

    cell(tu, "A42", "ค่าที่แนะนำ (หน่วย CENTUM)", big)
    for j, hd in enumerate(["", "แนะนำ", "ปัจจุบัน", "เทียบ"]):
        cell(tu, f"{'ABCD'[j]}43", hd, bold, head_fill, border=box)
    res = [
        (44, "PB (%)", '=IFERROR(100/B38,"—")', '=IF(ISNUMBER(PBcur),PBcur,"ไม่ระบุ")', '=IFERROR(IF(ISNUMBER(PBcur),"gain "&TEXT(PBcur/B44,"0.0#")&" เท่าของเดิม",""),"")'),
        (45, "TI (s)", '=IFERROR(B39*1,"—")', '=IF(ISNUMBER(TIcur),TIcur,"ไม่ระบุ")', '=IFERROR(IF(AND(ISNUMBER(TIcur),TIcur>0),TEXT(B45/TIcur,"0.0#")&" เท่าของเดิม",""),"")'),
        (46, "TD (s)", '=IFERROR(B40*1,"—")', '=IF(ISNUMBER(TDcur),TDcur,"ไม่ระบุ")', '=""'),
    ]
    for rr, label, a, b, cc in res:
        cell(tu, f"A{rr}", label, bold, border=box)
        cell(tu, f"B{rr}", a, Font(name=F, bold=True, size=13), border=box, fmt="0.##")
        cell(tu, f"C{rr}", b, border=box, fmt="0.##")
        cell(tu, f"D{rr}", cc, border=box)
    cell(tu, "A47", "Control action", bold)
    cell(tu, "B47", '=IFERROR(IF(IF(B20="Integrating",B24,B21)>0,"Reverse (MV ขึ้น → PV ขึ้น)","Direct (MV ขึ้น → PV ลง)"),"—")')
    cell(tu, "A48", "วิธี / λ", bold)
    cell(tu, "B48", '=IFERROR(B32&" · λ = "&TEXT(B35,"0.#")&" s","—")')
    warns = [
        '=IF(AND(ISNUMBER(B36),NOT(B37)),"✕ วิธีที่เลือกไม่ตรงกับชนิด model (level ใช้ Integrating)","")',
        '=IF(OR(NOT(ISNUMBER(B36)),B36=0),"! ยังไม่มี model: กรอก Kp, τ, θ (หรือ Ki, θ สำหรับ level)","")',
        '=IFERROR(IF(AND(ISNUMBER(PBcur),PBcur/B44>2),"! gain ใหม่แรงกว่าเดิม "&TEXT(PBcur/B44,"0.0")&" เท่า ควรเปลี่ยนเป็นขั้น (ทีละ ~50%) แล้วดูผล",IF(AND(ISNUMBER(PBcur),PBcur/B44<0.5),"! gain ใหม่อ่อนกว่าเดิม "&TEXT(B44/PBcur,"0.0")&" เท่า loop จะช้าลงชัดเจน แจ้ง operator ก่อน","")),"")',
        '=IFERROR(IF(AND(ISNUMBER(TIcur),TIcur>0,OR(B45/TIcur>3,B45/TIcur<1/3)),"! TI เปลี่ยนมากกว่า 3 เท่า ควรทำเป็นขั้นและเฝ้าดูผล",""),"")',
        '=IFERROR(IF(B25>B23,"! control period ยาวกว่า dead time จำกัดความเร็วที่ loop ทำได้",""),"")',
        '=IFERROR(IF(B40>0,"i มีค่า TD: ตรวจ derivative gain/filter ของ block บน CENTUM และระวัง PV noise",""),"")',
        '="i หลังเปลี่ยนค่า ให้เฝ้าดู trend อย่างน้อย 3–5 เท่าของ TI"',
    ]
    for i, f in enumerate(warns):
        cell(tu, f"A{50 + i}", f)
    cell(tu, "A58", "สมมติฐาน: ideal PID ของ CENTUM (PB = 100/Kc, e เป็น %span, MV เป็น %) · θ บวกครึ่ง control period · สูตร Lambda / SIMC (Skogestad) / IMC-PID / averaging level", muted)
    tu.column_dimensions["A"].width = 34
    tu.column_dimensions["B"].width = 22
    tu.column_dimensions["C"].width = 18
    tu.column_dimensions["D"].width = 70

    # ───────────────────────── Report ─────────────────────────
    rp = wb.create_sheet("Report", 3)
    cell(rp, "A1", '="รายงานสุขภาพ Loop: "&Loop', title)
    cell(rp, "A2", "=Health!A2", muted)
    cell(rp, "A3", "เอกสารประกอบการพิจารณาเท่านั้น ค่าหรือข้อเสนอแนะต้องผ่าน control engineer และ MOC ก่อนนำไปใช้", Font(name=F, bold=True, color="C00000"))
    cell(rp, "A5", "1. สรุป", big)
    cell(rp, "A6", "=Health!A6", Font(name=F, bold=True, size=14))
    cell(rp, "A7", "=Health!A7")
    cell(rp, "A8", "ควรทำอะไรต่อ", bold)
    for k, rr in enumerate(act_rows):
        cell(rp, f"A{rr}", f"=Health!A{rr}")
    for key, color in (("2", "bad"), ("1", "warn"), ("0", "good")):
        rp.conditional_formatting.add("A6:D14", FormulaRule(formula=[f"AND(N_ok>=10,Level={key},OR(Level>0,NOT(AllMan)))"], fill=FILL[color]))
    cell(rp, "A16", "2. ผลการตรวจ", big)
    for j, hd in enumerate(["หัวข้อ", "ค่า", "สถานะ", "ความหมาย"]):
        cell(rp, f"{'ABCD'[j]}17", hd, bold, head_fill, border=box)
    for rr in range(18, fr1 + 1):
        for col in "ABCD":
            cell(rp, f"{col}{rr}", f"=Health!{col}{rr}", bold if col in "AC" else norm, border=box, align=wrap if col == "D" else None)
        rp.row_dimensions[rr].height = 30
    status_rules(rp, f"C18:C{fr1}", "C18")
    tr = fr1 + 2
    cell(rp, f"A{tr}", "3. Trend ช่วงที่วิเคราะห์", big)
    trend_chart(rp, f"A{tr + 1}", "BC", ["PV", "SP"], "PV / SP", height=6.5)
    trend_chart(rp, f"A{tr + 15}", "D", ["MV"], "MV (%)", height=5)
    xy_chart(rp, f"A{tr + 26}")
    sr = tr + 45
    cell(rp, f"A{sr}", "4. Tuning (ถ้ามี model)", big)
    cell(rp, f"A{sr + 1}", '=IF(ISNUMBER(Tuning!B38),"แนะนำ PB "&TEXT(Tuning!B44,"0.#")&"% · TI "&TEXT(Tuning!B45,"0.#")&" s · TD "&TEXT(Tuning!B46,"0.#")&" s ("&Tuning!B48&") เทียบปัจจุบัน PB "&Tuning!C44&" · TI "&Tuning!C45,"ไม่มี (ข้อมูลไม่มี step test)")')
    cell(rp, f"A{sr + 3}", "ลงนาม", big)
    for i, lab in enumerate(["จัดทำโดย", "ตรวจโดย (Control Eng.)", "MOC No.", "วันที่"]):
        cell(rp, f"A{sr + 4 + i}", lab)
        cell(rp, f"B{sr + 4 + i}", "..............................................")
    rp.column_dimensions["A"].width = 26
    rp.column_dimensions["B"].width = 30
    rp.column_dimensions["C"].width = 14
    rp.column_dimensions["D"].width = 70
    rp.print_area = f"A1:D{sr + 8}"
    rp.page_setup.orientation = "portrait"
    rp.page_setup.fitToWidth = 1
    rp.page_setup.fitToHeight = 0
    for ws in (hs, tu, rp):
        ws.page_setup.orientation = "landscape" if ws is not rp else "portrait"
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
        ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)

    # sheet order: HowTo, Health, Tuning, Report, Setup, Data, Calc
    order = ["HowTo", "Health", "Tuning", "Report", "Setup", "Data", "Calc"]
    wb._sheets = [wb[n] for n in order]
    wb.active = 1
    if show_only:  # preview/PDF rendering only
        for ws in wb.worksheets:
            if ws.title not in show_only:
                ws.sheet_state = "hidden"
        wb.active = wb.sheetnames.index(show_only[0])
    wb.calculation = CalcProperties(fullCalcOnLoad=True)
    wb.save(path)
    return names


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "PI_Loop_Health.xlsx"
    build(out)
    print("saved", out)
