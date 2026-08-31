# Mtrii Notes — hướng dẫn chạy, bảo trì và chuyển máy

Ứng dụng sổ tay số **Mtrii Notes** (`com.mtrii.notes`). Đây **không** phải Goodnotes.

## Bản web (đang chạy)

- Lưu bằng **IndexedDB** trên trình duyệt, không cần đăng nhập, không gửi tài liệu lên máy chủ.
- Xóa dữ liệu trang / đổi trình duyệt / chế độ ẩn danh = mất sổ trừ khi đã xuất `.mtriibackup`.
- Không phải bộ cài Windows. Người dùng cuối của bản web không cần Node.js hay Rust.

## Định dạng sao lưu `.mtriibackup`

ZIP gồm `MANIFEST.json`, `README.txt`, `checksums.json`, `data/library.json`, `assets/`.
Phiên bản định dạng hiện tại: **1**. Nét viết còn chỉnh sửa được; PDF xuất đã gộp ghi chú **không** thay thế gói này.

### Chuyển máy

1. Máy cũ: Cài đặt → Xuất toàn bộ dữ liệu.
2. Chép tệp bằng USB hoặc thư mục cloud (chỉ đồng bộ **gói đã hoàn tất**, không thả file DB đang ghi).
3. Máy mới: mở Mtrii Notes tương thích → Nhập bản sao lưu → xem số sổ/trang → xác nhận.
4. Mặc định **gộp** vào thư viện (ID mới). Thay thế toàn bộ sẽ sao lưu dữ liệu hiện có trước.

Không bắt buộc cùng tài khoản hay cùng tên người dùng Windows.

## Bản Windows x64 (Tauri 2)

Hai tệp bàn giao nằm trong `artifacts/`:

- `Mtrii Notes_0.2.0_x64-setup.exe`: bộ cài NSIS cho tài khoản Windows hiện tại, có Start Menu và trình gỡ cài đặt.
- `Mtrii Notes_0.2.0_x64-portable.exe`: bản chạy trực tiếp để kiểm tra, không thay thế bộ cài khi dùng lâu dài.

Người dùng cuối không cần Node.js hoặc Rust. Bộ cài dùng chế độ `downloadBootstrapper`: Windows 11 thường đã có WebView2; nếu máy thiếu WebView2 thì bộ cài cần mạng để tải runtime. Đây chưa phải bộ cài WebView2 ngoại tuyến.

### Kho dữ liệu desktop

- SQLite: `%LOCALAPPDATA%\com.mtrii.notes\mtrii-notes.sqlite3`.
- PDF/ảnh/âm thanh: `%LOCALAPPDATA%\com.mtrii.notes\assets\`.
- Backup tự động: `%LOCALAPPDATA%\com.mtrii.notes\backups\`.
- Tệp được ghi qua tệp tạm, flush xuống đĩa rồi đổi tên; tệp tạm cũ hơn một giờ được dọn ở lần mở sau.
- Kho dữ liệu tách khỏi thư mục cài; gỡ ứng dụng mặc định không xóa kho này.

Định danh `com.mtrii.notes` và đường dẫn kho phải được giữ ổn định giữa các bản. Trước migration DB: tạo backup khôi phục được. Migration lỗi phải dừng, không tạo DB rỗng đè dữ liệu.

### Build lại trên Windows x64

Máy phát triển cần Node.js, Rust MSVC và Visual Studio C++ Build Tools. Sau khi cài phụ thuộc:

1. `npm run typecheck`
2. `npm run build`
3. `npm run desktop:build`

Tauri tạo NSIS tại thư mục `target/release/bundle/nsis/`. Bản 0.2.0 đã được build và chạy thử trên Windows 11 x64; chưa công bố Windows 10 hoặc ARM64.

### Giới hạn phát hành hiện tại

- Chưa cấu hình Tauri Updater, nguồn phát hành HTTPS hoặc khóa ký update; nút kiểm tra cập nhật báo đúng là chưa cấu hình.
- Bộ cài chưa ký Authenticode, nên Windows SmartScreen có thể cảnh báo. Không tắt antivirus/SmartScreen để né cảnh báo; bản phát hành chính thức cần chứng thư ký mã.
- Chưa kiểm thử bút phần cứng, chống tì tay, lực nhấn trên nhiều thiết bị, file PDF có mật khẩu, hoặc tài liệu PDF rất lớn.
- Không tuyên bố đạt “99% Goodnotes”; Mtrii Notes dùng thương hiệu, định dạng backup và cách triển khai riêng.

## Cập nhật

Nguồn phát hành HTTPS + gói ký. Không nhúng token GitHub. Trước khi cài bản mới: lưu hết + backup; nếu lưu/backup lỗi thì dừng.
