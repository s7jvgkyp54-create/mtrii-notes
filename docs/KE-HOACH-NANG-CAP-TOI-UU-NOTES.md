# Kế hoạch nâng cấp và tối ưu Notes

## Phạm vi

Chỉ nâng cấp những gì Notes đang có: tốc độ mở, độ mượt khi viết/đọc PDF, độ ổn định lưu trữ, bố cục, phản hồi thao tác và khả năng chẩn đoán. Không thêm chức năng mới và không đổi định dạng dữ liệu theo cách làm mất tương thích.

## Số đo nền 0.5.1

| Hạng mục | Hiện tại |
| --- | ---: |
| JavaScript khởi động desktop | 542.38 KB minified / 166.97 KB gzip |
| PDF engine | 464.07 KB / 137.07 KB gzip |
| Fontkit | 710.95 KB / 329.68 KB gzip |
| PDF worker | 1,265.41 KB |
| CSS desktop | 44.15 KB / 8.74 KB gzip |

Các module editor, settings, update dialog và một phần PDF hiện được import tĩnh; vì vậy nhiều `dynamic import` không tạo được ranh giới tải riêng như dự kiến.

## P0 — Khởi động nhanh và ổn định hơn

1. Tách `EditorView`, `SettingsView`, `UpdateDialog`, PDF import/export và fontkit thành chunk chỉ tải khi người dùng thực sự mở chúng.
2. Giữ bundle ban đầu chỉ gồm boot shell, recovery, store tối thiểu và Library.
3. Chuyển font giao diện sang WOFF2 đã tối ưu, preload đúng font cần cho màn hình đầu và giữ font PDF riêng ngoài đường khởi động.
4. Ghi thời gian 10 boot stages vào diagnostics để so sánh cold start/warm start theo từng bản phát hành.
5. Thêm performance budget vào CI: cảnh báo nếu initial desktop JS vượt 350 KB minified hoặc tăng trên 10%.

Mục tiêu chấp nhận:

- Loading UI xuất hiện dưới 300 ms.
- Thư viện sẵn sàng p50 dưới 900 ms, p95 dưới 2 giây với kho cỡ 1.000 sổ.
- Initial desktop JavaScript nhỏ hơn 350 KB minified.
- Lỗi của PDF, backup, update hoặc Pomodoro không được chặn màn hình thư viện.

## P1 — Viết, cuộn và xem PDF mượt hơn

1. Đưa parse/render PDF nặng hoàn toàn sang worker; chỉ render trang đang thấy và một trang đệm mỗi phía.
2. Gom pointer events theo animation frame, tránh render React trên từng điểm bút và chỉ cập nhật thumbnail khi người dùng ngừng viết.
3. Dùng cache có giới hạn cho bitmap/trang PDF; giải phóng canvas ngoài viewport để tránh tăng RAM sau phiên dài.
4. Virtualize danh sách/thư viện lớn, giữ focus và vị trí cuộn ổn định khi đổi sắp xếp hoặc quay lại từ editor.
5. Đo long task, FPS khi viết, thời gian đổi trang và mức RAM sau 30 phút; tối ưu theo số đo thay vì tăng debounce tùy ý.

Mục tiêu chấp nhận:

- Nét bút phản hồi trong khung hình kế tiếp và không giật thấy rõ ở 60 Hz.
- Cuộn PDF giữ trên 55 FPS ở máy phổ thông với tài liệu 100 trang.
- Không tăng RAM liên tục khi qua lại 50 trang.
- Không mất nét hoặc sinh bản ghi trùng khi đóng ứng dụng ngay sau khi viết.

## P1 — Database và lưu trữ bền hơn

1. Gom các truy vấn startup thành batch rõ ràng, chỉ đọc metadata cần cho Library; tải pages/objects khi mở sổ.
2. Thêm `busy_timeout`, theo dõi thời gian transaction và index theo các truy vấn thật như folder, updated time, favorite và trash.
3. Gom write nhỏ trong một transaction ngắn, nhưng giữ cơ chế flush bắt buộc khi đổi trang/đóng app.
4. Kiểm tra backup trước khi công bố thành công: manifest, checksum, schema version và khả năng đọc thử.
5. Xây bộ fixture dữ liệu lớn và dữ liệu hỏng để benchmark/migration test lặp lại được.

Mục tiêu chấp nhận:

- Không giữ transaction trong lúc đọc/ghi tệp lớn.
- Khôi phục backup lỗi không được thay thế kho đang hoạt động.
- Migration có thể chạy lại an toàn và luôn rollback toàn bộ khi một bước thất bại.

## P2 — Giao diện “xịn” hơn nhưng vẫn quen thuộc

1. Chuẩn hóa spacing, chiều cao control, bán kính và shadow giữa Library, Editor, Settings và Recovery.
2. Rút gọn thanh công cụ theo độ ưu tiên; trạng thái đang chọn, đang lưu, disabled và hover phải rõ nhưng không chói.
3. Dùng chuyển động 120–180 ms cho panel/dialog/menu, hỗ trợ `prefers-reduced-motion` và không animate layout lớn khi khởi động.
4. Cải thiện focus ring, tab order, nhãn icon, vùng chạm tối thiểu 40 px và độ tương phản của chữ phụ ở dark mode.
5. Giữ giấy viết sáng trong dark mode nhưng giảm chênh lệch độ sáng của nền bao quanh để đỡ mỏi mắt.
6. Đồng nhất empty/loading/error states với cùng ngôn ngữ, icon và hành động chính; tránh toast cho trạng thái cần người dùng đọc lâu.

Mục tiêu chấp nhận:

- Dùng được toàn bộ Library và Settings bằng bàn phím.
- Không có control dưới 40 px trên màn hình cảm ứng.
- Không layout shift nhìn thấy khi font hoặc thumbnail tải xong.
- Desktop 1280×800 và mobile 390×844 không tràn ngang, không che thao tác chính.

## Thứ tự triển khai đề xuất

1. Bản 0.5.2: code splitting + font + performance budget + số đo boot.
2. Bản 0.5.3: PDF/thumbnail worker, viewport cache và tối ưu nét bút.
3. Bản 0.5.4: batch database, benchmark kho lớn và backup verification.
4. Bản 0.5.5: polish đồng bộ Library/Editor/Settings/Recovery và accessibility.

Mỗi bản giữ nguyên cổng test của 0.5.1: unit tests, migration tests, dev/production smoke, mở release Windows hai lần và xác nhận dữ liệu hiện có vẫn đọc được.

## Trạng thái triển khai

Kế hoạch đã được hoàn tất và hợp nhất trong bản 0.5.5:

| Giai đoạn | Trạng thái | Kết quả chính |
| --- | --- | --- |
| P0 khởi động | Hoàn tất | entry desktop 313.96 KB, giảm 42.1%; có performance budget và boot diagnostics |
| P1 PDF/canvas | Hoàn tất | viewport rendering, LRU cache, rAF pointer pipeline và giải phóng canvas |
| P1 database/backup | Hoàn tất | startup/batch native, migration v3, mirror checkpoint và backup checksum/schema verification |
| P2 giao diện | Hoàn tất | font tối ưu, dark mode, focus, vùng chạm 40 px, reduced motion và responsive polish |
| QA release | Hoàn tất | test/build/smoke đạt; Windows release mở/đóng hai vòng với dữ liệu thật |

Chi tiết số đo, bài test và checksum artifact nằm trong `docs/BAO-CAO-NANG-CAP-NOTES-0.5.5.md`.
