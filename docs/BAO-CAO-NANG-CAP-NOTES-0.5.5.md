# Báo cáo nâng cấp Notes 0.5.5

## Kết quả

Notes 0.5.5 đã hoàn tất toàn bộ kế hoạch tối ưu hiện có mà không bổ sung tính năng mới. Bản Windows release tải đúng kho dữ liệu thật, mở được sổ PDF, đóng sạch ngay lần đầu và mở lại không mất dữ liệu.

## Nâng cấp chính

### Khởi động và bundle

- Tách Editor, Settings, hộp thoại cập nhật và các khối PDF nặng khỏi entry khởi động.
- Chuyển font giao diện sang WOFF/WOFF2; giữ font TTF chỉ cho xuất PDF.
- Thêm performance budget cho desktop entry: tối đa 350 KiB và không được tăng quá 10% so với baseline tối ưu.
- Thêm số đo boot stage, long task, FPS, thời gian đổi trang và heap khi môi trường hỗ trợ.
- Ổn định `startup.sh` trên Linux/Windows và loại thư mục build khỏi dev watcher để tránh lỗi `EBUSY` khi đóng gói.

### PDF, canvas và thư viện

- Cache PDF document, bitmap trang, kích thước trang và ảnh với giới hạn LRU rõ ràng.
- Chỉ render thumbnail/trang gần viewport; giải phóng canvas ngoài màn hình.
- Gom pointer event theo animation frame cho bút, shape, lasso, di chuyển và resize.
- Sửa lỗi thao tác di chuyển dùng state cũ và tránh ghi đối tượng lặp khi tẩy.
- Render thư viện tăng dần theo lô 50 mục, giữ vị trí cuộn khi quay lại.

### Database, lưu trữ và backup

- Gom dữ liệu startup trong một lệnh native và batch các lần ghi page/object.
- Thêm SQLite `busy_timeout`, index migration v3 và transaction rollback đầy đủ.
- Chỉ phục hồi mirror database khi khởi động; refresh mirror sau checkpoint thay vì sao chép ở mọi kết nối.
- Flush các thay đổi đang chờ khi đổi sổ, đóng tab và đóng ứng dụng.
- Kiểm tra schema, manifest, checksum, cấu trúc và tham chiếu trước khi chấp nhận backup.
- Sửa capability Tauri cho luồng đóng sau khi lưu; bản release đóng thành công ngay lần đầu khoảng 1,7 giây.

### Giao diện và accessibility

- Đồng bộ spacing, radius, shadow, màu dark mode và chuyển động 180 ms.
- Thêm focus ring rõ, trạng thái active/disabled, nhãn cho icon-only control và vùng chạm tối thiểu 40 px.
- Hỗ trợ `prefers-reduced-motion`; tối ưu bố cục thanh công cụ để không tràn ở desktop hẹp và mobile.
- Sửa các chuỗi tiếng Việt lỗi mã hóa và đường dẫn kho hiển thị trong Settings.

## Số đo

| Hạng mục | Trước | 0.5.5 | Thay đổi |
| --- | ---: | ---: | ---: |
| Desktop entry minified | 542.38 KB | 313.96 KB | giảm 42.1% |
| Desktop entry gzip | 166.97 KB | 98.66 KB | giảm 40.9% |
| Ngân sách entry | chưa có | 350 KiB | đạt |

## Xác minh

- 231 test JavaScript/TypeScript đạt; 2 test symlink bỏ qua đúng điều kiện Windows.
- 5 test Rust đạt, gồm migration, rollback batch và fixture 2.000 sổ tay.
- TypeScript typecheck: đạt.
- ESLint: đạt, 0 lỗi; còn 4 cảnh báo Fast Refresh không ảnh hưởng release.
- Web production build và desktop NSIS build: đạt.
- Dev và production smoke ở 1280×800 và 390×844: HTTP 200, không tràn ngang, không console/page error; production không lệch baseline.
- Windows release QA: tải đúng 2 thư mục, 3 sổ tay và kho 9,7 MB; PDF mẫu render được; đóng/mở lại hai vòng sạch và dữ liệu vẫn đầy đủ.

## Bản phát hành

| Tệp | Dung lượng | SHA-256 |
| --- | ---: | --- |
| `Notes_0.5.5_x64-setup.exe` | 6.332.275 byte | `58F8DADD1E1FEA1EE9A0D1B22E5CB54488BF1730C0D5D47B790EABDD2632B2C7` |
| `Notes_0.5.5_portable.exe` | 19.288.064 byte | `0EA638BB5F75F54DFB6FC2792CC3F6619C1722A69F3B5AA2D59015E356E84259` |
