---
title: solo-media-worker — Product Card
doc_id: CARD-solo-media-worker
doc_type: product-card
verdict: showcase
version: 0.1
date: 2026-10-11
status: ร่างเพื่อพิจารณา
owner: Product owner (Book Dev)
---

# solo-media-worker — Product Card

## 1. สรุปคุณค่าในหนึ่งประโยค

ถอดเสียงสื่อจาก OneDrive หรือ URL เป็นข้อความและสรุปผ่าน AI gateway โดยรันบน Node หรือ Cloudflare Workers

## 2. ปัญหาและผู้ใช้เป้าหมาย

ต้องถอดเสียงวิดีโอ/ไฟล์เสียงจำนวนมากโดยไม่ผูกกับเครื่อง ผู้ใช้คือเจ้าของ

## 3. สิ่งที่ทำได้จริงตอนนี้

- build เป็น `dist/node.mjs` และ `dist/cloudflare.mjs`; โมดูล `stt/`, `summarize/`, `sources/`
- router/registry ที่ vendor จาก solo-empire (`vendor/`)
- เทสต์ node --test 2 ไฟล์

## 4. หลักฐานสถานะ

| รายการ | ค่า |
|---|---|
| Stack | TypeScript (Node, Cloudflare Workers) |
| Commit | 3 ครั้ง (2026-10-08 ถึง 2026-10-11) |
| ซอร์สโค้ด | 24 ไฟล์ / 2692 บรรทัด |
| เทสต์ | 2 ไฟล์ (ไม่ได้รันในงานนี้) |
| CI | ไม่มี workflow |
| Deploy config | `Dockerfile` (Node/PaaS); ทะเบียนระบุ exception |
| Live URL | ไม่มี |

## 5. คุณค่าและจุดต่าง

- พกพาได้ทั้ง container และ Workers
- **[สมมติฐาน]** ไม่มีมูลค่าขาย

## 6. ช่องว่างสำคัญ

- สำเนา router อาจเบี่ยงจากต้นฉบับ
- ไม่มี CI; ไม่ยืนยันว่า provider STT ใดเชื่อมจริง **[ต้องยืนยัน]**

## 7. คำตัดสิน

**`showcase`** — เครื่องมือส่วนตัวที่ออกแบบพกพาได้ ยังไม่เห็นผู้ใช้อื่น จะเปลี่ยนเป็น `invest` หากใช้ถอดเสียงงานลูกค้าจริงเป็นประจำ

## 8. ขั้นต่อไป

1. ทดสอบถอดเสียงตัวอย่างจริงหนึ่งไฟล์

## การอนุมัติ

| บทบาท | สถานะ | วันที่ | ลงนาม |
|---|---|---|---|
| Product owner (Book Dev) | รอพิจารณา | — | ________ |

## แหล่งข้อมูล

- `README.md`
- `core/`, `stt/`, `summarize/`, `Dockerfile`
