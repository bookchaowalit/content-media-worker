# media-worker

Worker พกพาได้สำหรับถอดเสียงสื่อ (OneDrive/URL → speech-to-text → สรุปด้วย AI gateway) รันบน Node (container/PaaS) หรือ Cloudflare Workers

ที่มา: ย้ายมาจาก `solo-empire/infra/media-worker/` (2026-10-11) พร้อมประวัติ git ผ่าน `git subtree split`.

- `vendor/media_router.ts` และ `vendor/media-transcription-routing.json` คือสำเนาของ router/registry จาก `solo-empire/infra/api/media_router.ts` และ `infra/platform/media-transcription-routing.json` (ต้นฉบับ routing contract ยังอยู่ใน solo-empire)
- `systems/ai-data/media-transcription-pipeline.md` ใน solo-empire อธิบายสถาปัตยกรรม

## ใช้งาน

```bash
npm ci
npm test                      # unit tests (node --test via tsx)
npm run build                 # dist/node.mjs + dist/cloudflare.mjs
MEDIA_ROUTING_REGISTRY_PATH=vendor/media-transcription-routing.json \
  node --env-file-if-exists=.env.local dist/node.mjs transcribe --url <url> --name <file>
MEDIA_ROUTING_REGISTRY_PATH=vendor/media-transcription-routing.json \
  node --env-file-if-exists=.env.local dist/node.mjs eval --manifest samples.json
docker build -t solo-media-worker .
```

คีย์อยู่ใน `.env.local` (gitignored) ห้าม commit.

Sentry (ตัวเลือก): ตั้ง `SENTRY_DSN` บนโฮสต์ที่รัน Node entry; ไม่ตั้ง = ปิด. ส่งเฉพาะ error ที่ผ่าน allowlist (`core/sentry.ts`). สถานะและข้อจำกัดดู `PRODUCT.md`.
