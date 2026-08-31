# Hướng dẫn Phát hành & Tự động Cập nhật Notes qua GitHub

Tính năng tự động kiểm tra và cập nhật của **Notes** hoạt động dựa trên **GitHub Releases API**. Mỗi khi ứng dụng khởi động (hoặc khi bạn bấm "Kiểm tra bản cập nhật mới" trong Cài đặt), ứng dụng sẽ tự động kiểm tra xem có phiên bản mới hơn trên GitHub không.

---

## 1. Cấu hình GitHub Repository trong ứng dụng

1. Mở **Notes** -> Vào mục **Cài đặt** (Settings).
2. Cuộn xuống phần **Giới thiệu và cập nhật**.
3. Tại ô **GitHub Repository**, nhập địa chỉ kho mã nguồn của bạn:
   - Ví dụ: `username/notes` hoặc `https://github.com/username/notes`.
4. Đảm bảo công tắc **"Tự kiểm tra cập nhật khi mở"** đang bật (mặc định đã bật).

---

## 2. Cách đóng gói bản cài đặt mới

Khi bạn có thay đổi hoặc nâng cấp tính năng cho ứng dụng:

1. Mở file `src/lib/notes/types.ts` và `src-tauri/tauri.conf.json` để tăng số phiên bản:
   - Ví dụ từ `0.2.0` lên `0.2.1` hoặc `0.3.0`.
2. Chạy lệnh đóng gói bộ cài đặt Windows:
   ```bash
   npm run desktop:build
   ```
3. Sau khi đóng gói hoàn tất, file cài đặt sẽ nằm tại:
   `src-tauri/target/release/bundle/nsis/Notes_x.x.x_x64-setup.exe`

---

## 3. Cách tạo Release trên GitHub để người dùng nhận cập nhật

1. Truy cập vào Repository của bạn trên GitHub (`https://github.com/username/notes`).
2. Nhấn vào mục **Releases** ở thanh bên phải -> Chọn **Draft a new release** (hoặc **Create a new release**).
3. Điền các thông tin:
   - **Choose a tag**: Nhập tag tương ứng (ví dụ: `v0.2.1` hoặc `v0.3.0`) -> Chọn *Create new tag*.
   - **Release title**: Tên bản phát hành (ví dụ: `Notes v0.2.1 - Cập nhật giao diện và tính năng mới`).
   - **Describe this release**: Mô tả các điểm mới / sửa lỗi (nội dung này sẽ hiển thị trực tiếp trong hộp thoại cập nhật của ứng dụng).
4. **Attach binaries**: Kéo thả file `Notes_x.x.x_x64-setup.exe` vào ô đính kèm tài nguyên (Assets).
5. Nhấn **Publish release**.

---

## 4. Trải nghiệm cập nhật trên Notes

- **Tự động khi mở app**: Mỗi khi ứng dụng khởi động, nếu phát hiện phiên bản trên GitHub cao hơn phiên bản hiện tại, một hộp thoại đẹp mắt sẽ hiện lên hiển thị:
  - Phiên bản hiện tại và phiên bản mới (`v0.2.0 -> v0.2.1`).
  - Danh sách thay đổi (Changelog).
  - Dung lượng file cài đặt.
  - Nút **"Cập nhật và Khởi động lại"**: Ứng dụng sẽ tự động tải file `.exe` với thanh tiến trình % trực quan, sau đó mở bộ cài đặt và khởi động lại ứng dụng.
  - Nút **"Xem trên GitHub"**: Mở trang Release trên trình duyệt.
  - Nút **"Để sau"**: Đóng thông báo nếu bạn đang bận ghi chép.
- **Thủ công**: Bạn có thể vào Cài đặt và bấm **"Kiểm tra bản cập nhật mới"** bất cứ lúc nào.