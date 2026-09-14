# Game License System (Persistent Version)

Hệ thống quản lý license key cho game Android.  
**Phiên bản này đã sửa lỗi mất key** — hỗ trợ lưu trữ vĩnh viễn bằng PostgreSQL.

## Cấu trúc

```
license-server/     ← Server Node.js (deploy lên Railway)
admin-panel/        ← Web quản lý key
android-sdk/        ← Code Java tích hợp vào game
```

---

## BƯỚC 1 — Deploy server lên Railway (khuyến nghị)

1. Vào https://railway.app → Đăng ký bằng GitHub
2. **New Project → Deploy from GitHub repo**
   - Upload thư mục `license-server/` lên 1 repo GitHub mới
3. Vào tab **Variables**, thêm:
   ```
   ADMIN_TOKEN = (đặt mật khẩu mạnh, VD: mySecretPass2024)
   ```
4. **Thêm PostgreSQL** (bắt buộc để lưu key vĩnh viễn):
   - Trong project → **New** → **Database** → **Add PostgreSQL**
   - Railway tự động inject biến `DATABASE_URL`
5. Railway tự deploy → copy URL dạng `https://xxx.railway.app`

> Nếu không thêm PostgreSQL thì server vẫn chạy bằng SQLite nhưng **key sẽ bị mất** mỗi lần restart.

---

## BƯỚC 2 — Mở Admin Panel

1. Mở file `admin-panel/index.html` bằng trình duyệt
2. Điền:
   - **Server URL**: URL từ Railway
   - **Admin Token**: mật khẩu bạn đặt ở bước 1
   - Tick **Ghi nhớ đăng nhập**
3. Đăng nhập → tạo key và quản lý thiết bị

---

## BƯỚC 3 — Tạo key

Trong Admin Panel, tab **"Tạo Key mới"**:

| Trường          | Ý nghĩa                                      |
|-----------------|----------------------------------------------|
| Số lượng        | Tạo bao nhiêu key một lúc                    |
| Tiền tố         | VD: GAME, VIP, FREE                          |
| Tối đa thiết bị | 1 = chỉ 1 máy dùng được key này              |
| Thời hạn (giờ)  | 24 = 24h, 168 = 7 ngày, 720 = 1 tháng       |
| Ghi chú         | Tên người mua để dễ quản lý                  |

---

## BƯỚC 4 — Tích hợp vào game Android

1. Copy `android-sdk/LicenseManager.java` vào project
2. Sửa package name
3. Thêm permission Internet vào AndroidManifest.xml
4. Tham khảo `android-sdk/MainActivity_example.java`
5. Đổi URL server trong code Java

---

## API Endpoints

| Method | URL                              | Mô tả                          |
|--------|----------------------------------|--------------------------------|
| POST   | `/api/activate`                  | Kích hoạt key (game gọi)       |
| POST   | `/api/check`                     | Kiểm tra key còn hạn           |
| GET    | `/admin/keys`                    | Danh sách key (cần token)      |
| POST   | `/admin/keys`                    | Tạo key mới (cần token)        |
| DELETE | `/admin/keys/:key`               | Vô hiệu hoá key                |
| GET    | `/admin/keys/:key/devices`       | Xem thiết bị                   |
| DELETE | `/admin/activations/:key/:device_id` | Kick thiết bị              |

---

## Lưu ý kỹ thuật

- Khi có `DATABASE_URL` → dùng PostgreSQL (persistent)
- Không có `DATABASE_URL` → dùng SQLite (chỉ local/dev)
- Key và activation được lưu vĩnh viễn khi dùng PostgreSQL
