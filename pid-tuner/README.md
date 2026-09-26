# PID Loop Tuner

## ✅ ใช้ไฟล์ Excel เป็นหลัก: [`excel/PI_Loop_Health.xlsx`](excel/PI_Loop_Health.xlsx)

ไฟล์เดียวจบใน Excel (Microsoft 365) สูตรล้วน ไม่มี macro ใช้คู่กับ PI DataLink
- **Setup:** เปลี่ยนชื่อ loop 1 ช่อง และมีตาราง loop (ชนิด, SL/SH, หน่วย, PB/TI/TD) ใส่ครั้งเดียวต่อ loop
- **Data:** PI DataLink → Sampled Data ใส่ผลที่ `Data!A2` (สร้างครั้งเดียว) · รองรับ 20,000 แถว
- **Health:** บทสรุป ✓ ปกติ / ! ควรติดตาม / ✕ ควรแจ้ง engineer + สิ่งที่ควรทำต่อ + ผลตรวจ (AUTO %, error, OP ติดขอบ, noise, การแกว่งและคาบด้วย autocorrelation, คุณภาพข้อมูล/PI compression, SP ขยับ) + กราฟ trend และ OP vs PV
- **Tuning:** ตัวช่วยอ่าน Kp/θ/τ จาก trend DCS + คำนวณ PB/TI/TD (Lambda, SIMC, IMC-PID, averaging/tight level)
- **Report:** หน้าเดียวสำหรับพิมพ์ส่ง engineer
- [`excel/PI_Loop_Health_Example.xlsx`](excel/PI_Loop_Health_Example.xlsx) = ไฟล์เดียวกันแต่มีข้อมูลจำลอง (ลักษณะคล้าย 3FC1301B) ไว้ดูหน้าตาผลลัพธ์
- ไม่มีการตรวจ valve ติดอัตโนมัติ (ให้ดูกราฟ OP vs PV และ trend 1 วินาทีบน DCS)

สร้างใหม่: `python3 excel/make_workbook.py` · ตรวจสูตรเทียบกับ core ของ web app: `python3 excel/verify_workbook.py` (ต้องมี LibreOffice และ Node)

---

## Web app (หยุดพัฒนาแล้ว ยังใช้งานได้)

Web app ไฟล์เดียวสำหรับวิเคราะห์ control loop และแนะนำค่า **PB / TI / TD** (หน่วย CENTUM) จากข้อมูลที่ export จาก PI

- **ใช้ไฟล์เดียว:** [`dist/pid-tuner.html`](dist/pid-tuner.html) ดาวน์โหลดแล้วดับเบิลคลิกเปิดใน Chrome/Edge ได้เลย ไม่ต้องติดตั้งอะไร
- **Offline 100%:** ไม่โหลด library จาก internet และไม่ส่งข้อมูลออกนอกเครื่อง (build script ตรวจให้ทุกครั้ง)
- **Advisory only:** แอปแค่แนะนำ ไม่เขียนค่ากลับเข้า DCS การเปลี่ยนค่าต้องผ่าน control engineer และ MOC

## Export ข้อมูลจาก PI DataLink

1. ใน Excel → PI DataLink → **Sampled Data**
2. ใส่ tag ครบ 4 ตัว: `XXX.PV`, `XXX.SV`, `XXX.MV` และ `XXX.MODE` (ถ้ามี)
3. **Interval:** ให้สั้นพอ คือ ≤ 1/5 ของ time constant ของ loop
   - Flow / pressure: 1 s
   - Temperature: 5–10 s
   - Level: 1–5 s
4. เปิด "Show timestamps" ไว้ที่ column แรก
5. Save as CSV หรือ copy ทั้งตาราง (รวมหัวตาราง) ไป paste ในแอป

> ⚠ ถ้าใช้ **Compressed Data** ข้อมูลจะถูกบีบอัด ทำให้ noise และ stiction หายไป แอปจะเตือนถ้าตรวจพบ

รองรับรูปแบบต่อไปนี้:
- ตัวคั่น `,` `;` และ tab
- ทศนิยมแบบ comma
- วันที่แบบ `25-Sep-26 10:00:00`, `2026-09-25 10:00:00`, `25/09/2569` (ปี พ.ศ.), `25 ก.ย. 2569` และ Excel serial
- ค่า `Bad`, `I/O Timeout`, `Shutdown` จะถูกข้ามให้อัตโนมัติ

## ใช้แบบเร็ว (3 ขั้น)

1. ใน Excel ใช้ PI DataLink → Sampled Data ดึง `XXX.PV`, `XXX.SV`, `XXX.MV`, `XXX.MODE`
   - ใช้ template [`excel/PI_Tuner_Template.xlsx`](excel/PI_Tuner_Template.xlsx) ได้ (มีขั้นตอนในแท็บ HowTo)
   - template สร้างชื่อ tag เต็มแบบ DataLink ให้ เช่น `\\GCMPPISVR\3-CTA.2M.3AC1102B.MV` (PI server + area prefix + loop + suffix)
   - ตั้ง Sampled Data ครั้งแรกครั้งเดียว ครั้งต่อไปแค่เปลี่ยนชื่อ loop ที่ `Setup!B6`
2. เลือกทั้งตาราง แล้ว **Ctrl+C**
3. เปิดแอป แล้วกด **Ctrl+V** ที่หน้าไหนก็ได้

ผลที่ได้:
- paste แล้วไปหน้า **Loop Health** ทันที เห็น **บทสรุปภาษาคน + "ควรทำอะไรต่อ"** ด้านบนสุด ไม่ต้องทำ step test / MAN
- **tag ใหม่:** กรอก SL/SH (และหน่วย, ชนิด loop) ในแถบตั้งค่าบนหน้า Loop Health ครั้งเดียว แอปจำไว้ต่อ tag
- Tab 5 Report เป็น **รายงานสุขภาพ loop** (บทสรุป, ผลตรวจ, trend, OP vs PV) พิมพ์หรือ Save as PDF ส่ง engineer ได้
- ผล stiction ใช้กับ flow/pressure เท่านั้น และลดเป็น "ไม่ชัดเจน" เมื่อข้อมูลถูก PI compress หรือ SP ขยับตลอด (CAS/APC)
- รับได้ทั้งตารางที่มีหัวคอลัมน์หรือไม่มีหัว และแบบที่ DataLink ใส่คอลัมน์เวลาแยกให้ทุก tag (ไม่ต้องลบคอลัมน์เอง)

## วิธีใช้ (5 tab)

| Tab | ทำอะไร | ข้อมูลที่ต้องใช้ |
|---|---|---|
| 1. ข้อมูล | โหลด CSV จับคู่ column และตั้งค่า loop (**SL/SH ต้องตรงกับ DCS** เพราะใช้แปลง gain เป็น PB) | CSV |
| 2. Loop Health | ตรวจเวลาที่อยู่ใน AUTO, error, OP ติดขอบ, noise, **oscillation** (Thornhill) และ **valve stiction** (Horch cross-correlation) | ข้อมูล operation ปกติใน AUTO |
| 3. Step test → Model | ลากเลือกช่วงที่ step OP ใน MAN แล้ว fit model **FOPDT** (Kp, τ, θ) หรือ **integrating** (Ki, θ) สำหรับ level | ข้อมูล step test ใน MAN |
| 4. Tuning | คำนวณ PB/TI/TD ด้วย Lambda, SIMC, IMC-PID และ averaging level พร้อม GM/PM/Ms และจำลองเทียบค่าเดิมกับค่าใหม่ รวมกรณี model ผิด +30% | model จาก tab 3 หรือกรอกเอง |
| 5. Report | พิมพ์หรือ Save as PDF และ copy สรุปเป็นข้อความ (ซ่อนชื่อ tag ได้) | — |

ลองได้ทันทีด้วย **ข้อมูลตัวอย่างจำลอง** 5 ชุด (เลือกใน Tab 1):
- flow step test
- flow ที่ valve ติด
- pressure ที่ tune แรงเกิน
- temperature (วันที่แบบ พ.ศ.)
- level

## เช็ก PI Web API (ก่อนทำฟีเจอร์ดึงข้อมูลจาก PI อัตโนมัติ)

[`dist/pi-check.html`](dist/pi-check.html) เป็นหน้าเช็กแยกไฟล์ ใช้เปิดบนเครื่องที่ต่อ network โรงงาน
- กรอก URL เช่น `https://ชื่อserver/piwebapi`, วิธี login และ tag ทดสอบ แล้วกด **เริ่มตรวจ**
- หน้าจะตรวจทีละขั้น: ติดต่อ server → CORS และ login → เวอร์ชัน/user → รายชื่อ Data Server → หา tag → อ่านข้อมูล 10 นาทีล่าสุด
- ถ้าไม่ผ่าน จะบอกว่าติดขั้นไหนและควรทำอะไรต่อ
- ปุ่ม **Copy ผลสำหรับส่ง IT** ให้ข้อความสรุป ถ้าติด CORS จะรวมค่าที่ต้องขอ PI admin ตั้งไว้ด้วย (`CorsOrigins`, `CorsSupportsCredentials`, `CorsHeaders`)
- อ่านอย่างเดียว (GET) และส่ง request ไปเฉพาะ URL ที่กรอก password ไม่ถูกบันทึก
- แอปหลัก `pid-tuner.html` ยังไม่มีการเรียก network เลย (build ตรวจให้ทุกครั้ง)

## สมมติฐานที่ต้อง verify กับ manual CENTUM หรือ control engineer

- คำนวณแบบ ideal (non-interacting) PID: `MV = (100/PB)·[e + (1/TI)∫e dt + TD·de/dt]` โดย e เป็น %span และ MV เป็น %
  - ถ้า MV ไม่ใช่ 0–100% (เช่น cascade ไปเป็น SV ของ loop อื่น) ต้องแปลง gain ตาม span ของปลายทาง
- Derivative filter α = 0.1 และบวก dead time เพิ่มครึ่งหนึ่งของ control period
- Simulation ไม่รวม noise, valve dynamics และ nonlinearity
- Model เป็นการประมาณเชิงเส้นรอบจุดทำงานที่ test

## สำหรับนักพัฒนา

```bash
node pid-tuner/tools/gen-samples.mjs      # สร้าง samples/*.csv ใหม่ (deterministic)
node --test pid-tuner/test/*.test.mjs     # unit tests (parse, fit, tuning, margins, health)
node pid-tuner/build.mjs                  # รวม src/ + samples → dist/pid-tuner.html
node pid-tuner/test/e2e.browser.mjs [dir] # browser test ด้วย Playwright + screenshot
node pid-tuner/test/e2e.picheck.mjs [dir] # pi-check กับ mock PI Web API
```

| ไฟล์ | หน้าที่ |
|---|---|
| `src/core.js` | คณิตศาสตร์ทั้งหมด (ไม่มี DOM จึงเทสด้วย Node ได้) |
| `src/charts.js` | canvas chart ที่เขียนเอง |
| `src/app.js` | UI |
| `src/index.html` | layout และ CSS |

ทุก component ไม่มี dependency
