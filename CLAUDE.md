# CLAUDE.md

## Owner
Coke — นักลงทุนแนว picks-and-shovels (semiconductor, power, networking,
EDA, data center). ตลาด: US หลัก, SET, เวียดนาม. Horizon 1–3 ปี.

## Single Source of Truth
พอร์ต / watchlist / event ทั้งหมดอยู่ในหน้า Notion หน้าเดียว = ข้อมูลจริง
**ห้าม hardcode รายชื่อหุ้น — ดึงจาก Notion เสมอ** (fallback เฉพาะตอนเข้าไม่ได้)
- URL: https://app.notion.com/p/396a3f4bac3981f18732f7fcf8ada1f5
- Watchlist ที่มี ⭐ = track earnings ด้วย; ตอนอ่าน ticker ให้ ignore ⭐
- โซน Earnings Dates อยู่ระหว่าง marker `AUTO-EARNINGS:START/END` —
  routine เขียนเฉพาะในบล็อกนี้ ห้ามแตะโซน Manual Watch หรือ replace ทั้งหน้า

## Routines
- **Weekly Earnings Watch** (จันทร์ 07:30) — หาวันงบ → เขียนลง Notion + Calendar
- **Daily Market News** (จ–ศ 08:30) — สรุปข่าว 3 ตลาด + อ่านวันงบจาก Notion มาเสริม
- เชื่อมกันผ่าน Notion: weekly เขียน, daily อ่าน

## Style & Rules
- ตอบตรงประเด็น มีโครงสร้าง; ไทย/อังกฤษตามบริบท
- ไม่แน่ใจให้ถามก่อน อย่าเดา; ห้ามแต่งวันงบ/ตัวเลข → "ไม่พบข้อมูล"
- เรื่องหุ้น: ให้ข้อมูลประกอบการตัดสินใจ ไม่ชี้นำ; flag ถ้าหลุด thesis
- แยก cyclical (NUE, FCX) กับ structural (ANET, CDNS, VRT); อย่าตีความ
  miss/beat เป็นสัญญาณซื้อขายทันทีโดยไม่มี fundamental reason
