# Báo cáo sửa lỗi khởi động Notes 0.5.1

## Kết quả

Notes 0.5.1 đã mở thành công bằng binary release trên Windows, tải đúng kho dữ liệu hiện có và mở lại bình thường sau một lần đóng sạch. Không có dữ liệu ghi chú nào bị xóa hoặc ghi đè trong quá trình kiểm tra.

## Nguyên nhân gốc

1. Luồng hydrate gọi `pomodoroHistory`, nhưng native database chưa hỗ trợ entity này. Lỗi phụ bị ném lên toàn bộ startup promise nên cửa sổ Tauri dừng ở màn hình trắng.
2. Desktop build dùng đường dẫn asset tuyệt đối. Khi chạy bằng giao thức nội bộ của Tauri, JavaScript/CSS có thể không được nạp đúng dù bản web vẫn hoạt động.
3. `desktop/index.html` không có nội dung dự phòng. Nếu bundle lỗi hoặc tải chậm, người dùng chỉ thấy một cửa sổ trắng vô thời hạn.
4. Các tác vụ không thiết yếu như lịch Pomodoro, danh sách backup và kiểm tra cập nhật có thể làm thất bại toàn bộ quá trình mở thư viện.

## Thay đổi chính

- Dùng asset path tương đối cho desktop build và thêm boot shell tĩnh hiển thị ngay cả khi JavaScript chính chưa chạy.
- Thêm bộ theo dõi 10 giai đoạn khởi động, thời gian từng bước, mã lỗi ổn định và cảnh báo khi một bước bị kẹt.
- Thêm top-level React error boundary, màn hình phục hồi, Safe Mode và tùy chọn bỏ qua phiên làm việc trước.
- Chỉ đề nghị Safe Mode sau 2 lần khởi động lỗi liên tiếp; một lần đóng sạch sẽ xóa bộ đếm lỗi.
- Tách tác vụ thiết yếu khỏi tác vụ tùy chọn. Lỗi Pomodoro/backup/update chỉ tạo cảnh báo, không chặn thư viện.
- Bổ sung migration SQLite có transaction cho `tombstones` và `pomodoro_history`; hỗ trợ đầy đủ get/put/delete.
- Cô lập hàng JSON hỏng và cấu hình sai mà không xóa dữ liệu gốc trong database.
- Thêm diagnostics Windows/WebView2/database/migration/dung lượng, xuất log đã che đường dẫn và token nhạy cảm.
- Đồng bộ phiên bản ứng dụng, Rust crate và NSIS installer lên 0.5.1.

## Xác minh

- TypeScript typecheck: đạt.
- Web production build: đạt.
- Desktop production build: đạt.
- 231 bài test JavaScript/TypeScript đạt; 2 bài symlink được bỏ qua đúng điều kiện trên Windows.
- 3 bài Rust database/migration đạt.
- Dev và production browser smoke ở 1280×800 và 390×844: HTTP 200, không tràn ngang, không console error, không page error, production không lệch baseline.
- Windows release QA: tải đúng 2 thư mục, 3 sổ tay và kho 9.7 MB; trang Cài đặt báo phiên bản 0.5.1; lần mở thứ hai vẫn hoạt động.

## Bản phát hành

- `artifacts/Notes_0.5.1_x64-setup.exe`
- `artifacts/Notes_0.5.1_portable.exe`
