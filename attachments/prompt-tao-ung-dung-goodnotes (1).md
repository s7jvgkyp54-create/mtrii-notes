Hãy xây dựng một ứng dụng Windows ghi chú cá nhân tên “Mtrii Notes”, lấy Goodnotes làm mẫu về giao diện, cách tổ chức sổ và thao tác viết/đọc PDF.

Mục tiêu là giống Goodnotes tối đa, hướng tới 99% ở các màn hình và luồng sử dụng có ảnh tham chiếu. Không tự tuyên bố đã đạt 99% nếu chưa đối chiếu. Dùng tên và biểu tượng riêng cho ứng dụng.

1. NỀN TẢNG VÀ PHẠM VI

- Xây dựng ứng dụng desktop cài trên Windows bằng Tauri 2 + React + TypeScript, giao diện tiếng Việt. Ưu tiên Windows 11 x64 và máy tính bảng Windows; chỉ công bố hỗ trợ Windows 10 hoặc ARM64 sau khi kiểm thử tương ứng.
- Đóng gói trình cài đặt .exe bằng NSIS, có thể thêm .msi khi cần. Có biểu tượng, Start Menu, phiên bản, trình gỡ cài đặt và cửa sổ riêng; không chỉ tạo shortcut mở website.
- Kiểm tra WebView2 Runtime khi cài đặt và cung cấp phương án cài phù hợp; nói rõ bộ cài cần mạng hay đã kèm runtime cho cài ngoại tuyến. Người dùng cuối không phải cài Node.js hoặc Rust.
- Dùng riêng cho một người, không bắt buộc đăng nhập, không quảng cáo, không giới hạn số sổ bằng cơ chế trả phí.
- Bản đầu phải đọc PDF, viết, chỉnh sửa và lưu dữ liệu thật. Không chỉ dựng giao diện minh họa.
- Tính năng cốt lõi hoạt động ngoại tuyến sau khi cài ứng dụng và nhập tài liệu. Không mặc định tải tài liệu lên máy chủ. Cập nhật app, đồng bộ và AI trực tuyến là các chức năng riêng cần mạng.
- Nếu đã có dự án, tiếp tục kiến trúc hiện có; không tự xóa hoặc viết lại toàn bộ.

2. GIAO DIỆN

- Phong cách sổ tay số: nền trắng/xám nhạt, màu nhấn xanh, đường viền mảnh, biểu tượng rõ, khoảng cách gọn; ưu tiên diện tích trang viết.
- Màn hình thư viện: thanh điều hướng với Tất cả tài liệu, Gần đây, Yêu thích, Thùng rác, Cài đặt; vùng chính hiển thị bìa sổ theo lưới hoặc danh sách.
- Thanh trên có tìm kiếm, sắp xếp, chọn nhiều tài liệu, tạo mới và nhập PDF.
- Màn hình ghi chú: hàng tab tài liệu, tên sổ, quay về thư viện, trạng thái lưu, xuất tệp; bên dưới là thanh công cụ viết.
- Bên trái có bảng thu nhỏ trang, mục lục và dấu trang, có thể thu gọn. Ở giữa là giấy trên nền xám; có thu phóng và số trang.
- Nhấn công cụ đang chọn để mở bảng màu, độ dày và tùy chọn. Hiển thị rõ công cụ đang hoạt động.
- Hỗ trợ sáng/tối nhưng giữ giấy dễ đọc. Trên màn hình nhỏ, thu gọn thanh bên và công cụ.
- Nếu có ảnh chụp giao diện tham chiếu, bám sát vị trí, kích thước, màu và trạng thái tương tác. Nếu chỉ có logo, không coi đó là ảnh tham chiếu giao diện.

3. THƯ VIỆN VÀ SỔ TAY

- Tạo, đổi tên, nhân bản, di chuyển, đánh dấu yêu thích và xóa sổ; tài liệu đã xóa vào thùng rác để khôi phục.
- Tạo thư mục nhiều cấp; tìm theo tên và sắp xếp theo tên/ngày sửa.
- Chọn bìa, khổ A4/A5, giấy dọc/ngang, màu giấy; có giấy trắng, kẻ dòng, ô vuông, chấm và Cornell.
- Thêm, chèn, nhân bản, xoay, sắp xếp lại và xóa trang; đổi mẫu giấy từng trang.
- Mở nhiều sổ bằng tab; nhớ trang đang đọc và mức thu phóng.

4. VIẾT VÀ CHỈNH SỬA

- Bút bi, bút máy, bút chì với nét khác nhau; chọn màu, độ dày và lưu bộ màu thường dùng.
- Bút đánh dấu trong suốt, vẫn đọc được chữ bên dưới.
- Tẩy toàn nét và tẩy một phần nét; có tùy chọn chỉ tẩy highlight.
- Lasso khoanh chọn nét viết, chữ, ảnh; di chuyển, đổi kích thước, xoay, sao chép, cắt, dán, đổi màu và xóa phù hợp loại đối tượng.
- Chèn hộp văn bản tiếng Việt, chọn font/cỡ/màu/căn lề; sửa lại được sau khi lưu.
- Chèn ảnh từ tệp hoặc clipboard, thay đổi kích thước, xoay, cắt ảnh.
- Vẽ đường thẳng, mũi tên, hình chữ nhật và hình tròn; giữ bút để nắn hình khi khả thi.
- Undo/redo theo thao tác; phím tắt chuẩn, nhưng không chiếm phím khi đang nhập chữ.
- Hỗ trợ chuột, cảm ứng và bút. Có chế độ chỉ viết bằng bút, dùng ngón tay để di chuyển trang.
- Dùng lực nhấn khi thiết bị và WebView2 cung cấp. Kiểm thử bút trên máy Windows thực tế; không hứa chống tì tay hoặc độ trễ tương đương Goodnotes nếu chưa đo và kiểm thử.

5. PDF — CHỨC NĂNG ƯU TIÊN CAO NHẤT

- Nhập PDF thật bằng chọn tệp hoặc kéo thả; giữ đúng số trang, kích thước và hướng trang.
- Viết, tô sáng, thêm chữ và ảnh trực tiếp lên từng trang PDF.
- Tách tài liệu gốc khỏi lớp ghi chú; lưu nét theo tọa độ trang để không lệch khi cuộn, zoom hoặc xoay.
- Có cuộn liên tục, chuyển từng trang, vừa chiều rộng và vừa trang.
- Tìm kiếm văn bản có sẵn trong PDF; hỗ trợ mục lục, dấu trang và liên kết trong khả năng triển khai.
- Xuất PDF kèm ghi chú đúng vị trí, màu và kích thước; giữ nội dung gốc sắc nét khi có thể. Nhúng font hỗ trợ tiếng Việt.
- Xuất bản sao dự án riêng để mở lại và tiếp tục chỉnh sửa từng đối tượng. Nói rõ PDF xuất đã gộp ghi chú không thay thế bản sao dự án.
- Tải trang theo nhu cầu, không render toàn bộ PDF lớn cùng lúc. Báo rõ tệp lỗi, tệp có mật khẩu hoặc tính năng chưa hỗ trợ.

6. LƯU DỮ LIỆU VÀ ĐỘ TIN CẬY

- Dữ liệu chính của bản Windows phải lưu bằng SQLite và các tệp trên ổ cứng, không phụ thuộc IndexedDB, localStorage hoặc cache WebView. Nếu giữ bản web, dùng lớp lưu trữ riêng và giải thích rõ khác biệt.
- SQLite lưu thư mục, sổ, trang, nét viết có thể sửa, hộp chữ, vị trí đối tượng, dấu trang và phiên bản cấu trúc dữ liệu. PDF gốc, ảnh và âm thanh lưu trong thư mục tài nguyên, liên kết bằng ID và đường dẫn tương đối.
- Khi nhập PDF/ảnh, sao chép vào kho của app; xóa bản gốc ở Downloads không được làm hỏng sổ. Nét viết phải còn chỉnh sửa được sau khi mở lại.
- Dùng API thư mục dữ liệu của Windows/Tauri. Với identifier ổn định com.mtrii.notes, vị trí đề xuất là %LOCALAPPDATA%\com.mtrii.notes\; không hard-code tên người dùng. Cấu hình đường dẫn SQLite thực tế về cùng kho, không giả định đường dẫn mặc định của plugin trùng vị trí này.
- Tách kho dữ liệu khỏi thư mục cài chương trình. Không đổi identifier, tên kho hoặc đường dẫn giữa các bản cập nhật nếu không có bước di chuyển an toàn.
- Tự lưu sau mỗi thao tác hoàn tất, ví dụ kết thúc nét viết; gom thay đổi liên tục trong khoảng ngắn. Hiển thị “Đang lưu”, “Đã lưu” hoặc lỗi thật; chỉ báo đã lưu sau khi ghi thành công.
- Dùng transaction và ghi tệp nguyên tử phù hợp, bảo đảm DB không trỏ tới tài nguyên chưa ghi xong. Xử lý hết dung lượng, mất quyền ghi và ứng dụng bị tắt đột ngột; không hứa bảo vệ được thao tác chưa kịp ghi hoặc ổ đĩa bị hỏng.
- Khởi động lại máy, đóng/mở app, cập nhật và cài lại app trên cùng hồ sơ phải giữ dữ liệu đã lưu theo thiết kế và được kiểm thử. Khi gỡ cài đặt, mặc định giữ dữ liệu; chỉ xóa dữ liệu qua lựa chọn riêng có xác nhận rõ.
- Trong Cài đặt > Dữ liệu: hiển thị vị trí, dung lượng, lần lưu gần nhất và nút mở thư mục. Nếu cho đổi vị trí kho, phải đóng DB, sao chép, kiểm tra rồi mới chuyển; không xóa kho cũ trước khi xác nhận thành công.
- Không tuyên bố dữ liệu đã mã hóa chỉ vì dùng SQLite. Nếu bổ sung mã hóa, dùng thư viện chuẩn và thiết kế khóa rõ ràng; không tự tạo thuật toán mật mã.

7. SAO LƯU VÀ CHUYỂN SANG MÁY KHÁC

- Có Cài đặt > Sao lưu và khôi phục, nút “Xuất toàn bộ dữ liệu”, “Nhập bản sao lưu”, “Sao lưu ngay” và tùy chọn thư mục sao lưu.
- Định nghĩa định dạng dự án .mtriibackup, là một gói ZIP có tài liệu mô tả cấu trúc, số phiên bản định dạng, phiên bản app, thời điểm tạo, dữ liệu và checksum. Đây là định dạng của Mtrii Notes, không phải định dạng Goodnotes.
- Gói phải gồm thư mục, sổ, trang, PDF, ảnh, nét còn chỉnh sửa được, dấu trang, bìa và âm thanh nếu có; có thể tái tạo thumbnail. Không đưa token đăng nhập, khóa ký phát hành hoặc bí mật của nhà phát triển vào backup.
- Tạo snapshot SQLite nhất quán bằng SQLite Backup API hoặc cơ chế tương đương; giữ tài nguyên liên quan nhất quán với snapshot. Không copy thô riêng file DB khi app đang ghi. Tệp backup ghi vào tên tạm, kiểm tra xong mới đổi sang tên hoàn chỉnh.
- Cho bật sao lưu tự động ít nhất một lần mỗi ngày có thay đổi, khi app đang chạy; nếu bỏ lỡ thì chạy bù ở lần mở tiếp theo. Nói rõ app đóng thì không tự chạy, trừ khi đã triển khai tác vụ nền riêng.
- Mặc định giữ 7 bản gần nhất, cho chỉnh số lượng; chỉ dọn bản cũ sau khi tạo bản mới thành công. Backup trước nâng cấp phải được giữ tới khi người dùng đã xác nhận app mới hoạt động ổn định.
- Cho chọn nơi lưu backup: ổ cứng ngoài, USB hoặc thư mục được OneDrive/Google Drive đồng bộ. Cảnh báo backup trên cùng ổ đĩa không bảo vệ khỏi mất máy hoặc hỏng ổ; chỉ báo hoàn tất tạo tệp, không báo đã lên cloud nếu chưa xác nhận trạng thái đó.
- Luồng chuyển máy: máy cũ xuất .mtriibackup → chép bằng USB hoặc tải qua cloud → máy mới cài bản app tương thích → chọn nhập backup → xem bản xem trước số sổ/trang/dung lượng → xác nhận → kiểm tra dữ liệu. Không bắt buộc tài khoản hay cùng tên người dùng Windows.
- Khi khôi phục, kiểm tra checksum, phiên bản, tài nguyên thiếu, dung lượng sau giải nén và đường dẫn nguy hiểm trong ZIP. Giải nén vào vùng tạm; kiểm tra xong mới thay đổi dữ liệu đang dùng.
- Mặc định nhập vào thư viện mới để không ghi đè dữ liệu hiện có. Nếu chọn thay thế, phải sao lưu dữ liệu hiện tại và xác nhận trước. Nếu hỗ trợ gộp, xử lý trùng ID và xung đột rõ ràng, không âm thầm ghi đè.
- Bản app mới phải hỗ trợ các backup cũ theo phạm vi đã công bố. Khi backup mới hơn khả năng đọc, hướng dẫn nâng cấp; không sửa hoặc phá file backup. Không mặc định hạ phiên bản app sau khi đã nâng cấp cấu trúc DB.
- Nếu thêm backup mã hóa bằng mật khẩu, phải giải mã được trên máy khác với mật khẩu đó; dùng thư viện mã hóa chuẩn, xác thực toàn vẹn, không chỉ khóa vào tài khoản Windows cũ. Cảnh báo không thể khôi phục khi quên mật khẩu nếu không có cơ chế phục hồi riêng.
- Có xuất riêng từng sổ và xuất PDF để đọc lâu dài bằng phần mềm khác. PDF đã gộp ghi chú không thay thế backup chứa nét chỉnh sửa được.

8. CẬP NHẬT ỨNG DỤNG WINDOWS

- Có Cài đặt > Giới thiệu và cập nhật: phiên bản hiện tại, lần kiểm tra cuối, “Kiểm tra cập nhật”, bật/tắt tự kiểm tra, ghi chú phát hành, tiến trình tải và thông báo lỗi.
- Mặc định tự kiểm tra khi mở app, không chặn việc học; có thể kiểm tra lại định kỳ khi app chạy. Nút kiểm tra thủ công luôn dùng được khi có mạng. Phân biệt “đang dùng bản mới nhất”, “không có mạng”, “máy chủ lỗi” và “chưa cấu hình nguồn cập nhật”.
- Khi có bản mới, hiển thị phiên bản và nội dung thay đổi, cho “Tải và cài đặt” hoặc “Để sau”. Nếu bật tự tải, vẫn không tự đóng app khi đang viết; lưu xong rồi xin xác nhận khởi động lại. Không làm mất công việc đang mở.
- Dùng Tauri Updater, nguồn phát hành HTTPS thực tế và gói cập nhật được ký. Có thể dùng GitHub Releases kèm metadata cập nhật hoặc máy chủ phù hợp. Không nhúng token riêng của kho GitHub vào app; nếu dùng nơi phát hành riêng tư phải thiết kế truy cập an toàn.
- Hướng dẫn đầy đủ cho người bảo trì: sửa mã → tăng số phiên bản → build/kiểm thử trên Windows → ký gói → tải bộ cài và chữ ký → công bố metadata sau cùng. Chuẩn bị cấu hình phát hành nhưng không tự công khai tài liệu, mã riêng hoặc thông tin xác thực.
- Tự cập nhật chỉ lấy phiên bản Mtrii Notes đã được người phát triển phát hành. Không tự viết tính năng mới, không tự lấy bản cập nhật của Goodnotes và không tự đồng bộ dữ liệu học tập.
- Trước khi cài, lưu hết thay đổi và tạo backup nhất quán; nếu lưu/backup lỗi thì dừng cập nhật. Trước khi chuyển đổi DB trong bản mới, vẫn phải bảo đảm có backup khôi phục được.
- Mỗi phiên bản DB có migration được kiểm thử và theo thứ tự. Nếu migration lỗi, không tạo DB rỗng đè lên dữ liệu; dừng và hướng dẫn phục hồi từ bản sao tương thích. Chỉ quay lại app cũ khi cấu trúc dữ liệu còn tương thích hoặc đã phục hồi backup trước nâng cấp.
- Bảo quản khóa riêng ký cập nhật bên ngoài mã nguồn và bộ cài, dùng secret của môi trường build và có bản sao an toàn. Chữ ký Tauri Updater khác với chữ ký Windows Authenticode; một loại không thay thế loại kia.
- Nêu rõ khi bộ cài chưa có chữ ký Windows phù hợp, cảnh báo Windows có thể xuất hiện; không hướng dẫn tắt antivirus, SmartScreen hay bỏ kiểm tra chữ ký để né lỗi.
- Nếu chưa có nguồn phát hành/khóa ký, có thể bàn giao bản cài thủ công và phần cấu hình còn thiếu, nhưng không tuyên bố auto-update đã hoạt động. Luôn có phương án tải bộ cài mới và cài đè sau khi sao lưu.

9. ĐỒNG BỘ NHIỀU MÁY — TÁCH BIỆT VỚI SAO LƯU

- Bản đầu phải hoàn chỉnh chế độ dùng trên máy, backup và chuyển máy thủ công; không bắt buộc dựng máy chủ để ghi chú.
- Nếu người dùng muốn dùng đồng thời hai máy, bổ sung đồng bộ riêng có xác thực, ID thiết bị, phiên bản tài liệu, hàng đợi ngoại tuyến và xử lý xung đột. Hiển thị “Đã lưu trên máy” tách biệt “Đã đồng bộ”.
- Không đặt file SQLite đang dùng vào thư mục OneDrive/Google Drive rồi gọi đó là đồng bộ an toàn. Chỉ đồng bộ gói backup đã hoàn tất nếu chưa có cơ chế đồng bộ cấp ứng dụng.
- Mặc định không tự gửi tài liệu lên cloud. Nêu nhà cung cấp, dung lượng, chi phí nếu có, quyền truy cập và cách ngắt kết nối. Chỉ triển khai kết nối tài khoản thật khi được yêu cầu.
- Đồng bộ không thay thế backup: thao tác xóa hoặc sửa nhầm có thể lan sang máy khác. Giữ lịch sử phiên bản hoặc backup riêng và có luồng phục hồi.

10. TÍNH NĂNG NÂNG CAO

Sau khi phần cốt lõi ổn định, tiếp tục bổ sung: chia đôi màn hình PDF/sổ, thước kẻ, con trỏ laser, nhãn dán, băng che đáp án, flashcard tự tạo và ghi âm gắn mốc thời gian với ghi chú.

OCR chữ viết tay, chuyển chữ viết thành văn bản, nhận dạng công thức, tìm kiếm chữ viết tay và AI hỏi đáp theo tài liệu cần có engine hoặc dịch vụ thật. Nêu rõ ngôn ngữ hỗ trợ, điều kiện ngoại tuyến, chi phí và dữ liệu cần gửi đi. Khi chưa cấu hình, ẩn hoặc ghi rõ chưa khả dụng; không trả kết quả giả. Không để phần nâng cao làm hỏng chức năng viết và lưu.

11. TRIỂN KHAI VÀ BÀN GIAO

- Với dự án mới, dùng Tauri 2 + React + TypeScript; SQLite và quản lý tệp qua backend Rust/phạm vi quyền phù hợp. Có thể dùng [PDF.js](https://mozilla.github.io/pdf.js/) để hiển thị và [pdf-lib](https://pdf-lib.js.org/) để tạo/xuất PDF. Chỉ dùng phiên bản thư viện tương thích đã kiểm tra.
- Triển khai theo tài liệu chính thức về [bộ cài Windows](https://v2.tauri.app/distribute/windows-installer/), [Tauri Updater](https://v2.tauri.app/plugin/updater/), [thư mục dữ liệu](https://v2.tauri.app/reference/javascript/api/namespacepath/#applocaldatadir), [SQLite Backup API](https://www.sqlite.org/backup.html) và [ký mã Windows](https://v2.tauri.app/distribute/sign/windows/).
- Dùng lớp vẽ phù hợp cho nét và đối tượng; tách khỏi lớp render PDF. Lưu nét dạng dữ liệu chỉnh sửa được.
- Chia mã thành thư viện tài liệu, trình soạn thảo, công cụ vẽ, xử lý PDF, lưu trữ, sao lưu và cập nhật. Giới hạn quyền filesystem/IPC; không trao quyền chạy lệnh tùy ý cho nội dung PDF hoặc giao diện.
- Tự chọn các chi tiết kỹ thuật thông thường rồi triển khai. Không chỉ trả về kế hoạch.
- Thứ tự thực hiện: khung app Windows và lưu → PDF và viết → chỉnh sửa và xuất → backup/khôi phục → bộ cài và cập nhật → tinh chỉnh giao diện → tính năng nâng cao.
- Không coi giao diện đẹp hoặc MVP là đã hoàn thành toàn bộ. Báo chính xác phần đã làm, đã kiểm thử, còn thiếu và giới hạn môi trường.

Trước khi bàn giao, hãy kiểm thử các luồng:

1. Tạo sổ, viết tiếng Việt, chèn ảnh; đóng/mở app, khởi động lại máy và kiểm tra dữ liệu. Xóa tệp nguồn đã nhập ở Downloads để xác nhận app đã giữ bản riêng.
2. Nhập PDF nhiều trang, ghi chú ở nhiều mức zoom, xoay trang; kiểm tra nét không lệch.
3. Lasso, tẩy một phần, undo/redo; xác nhận dữ liệu vẫn đúng sau khi mở lại.
4. Xuất PDF và mở bằng trình đọc khác để đối chiếu.
5. Xuất backup rồi nhập trên hồ sơ Windows hoặc máy/VM khác có đường dẫn khác; kiểm tra đủ PDF, trang, nét chỉnh sửa được, ảnh, âm thanh và dấu trang. Thử backup lỗi, thiếu tài nguyên, sai mật khẩu và phiên bản không tương thích.
6. Thử ngoại tuyến, hết dung lượng và nhập tệp lỗi; không báo thành công giả.
7. Kiểm tra giao diện desktop/tablet; đối chiếu ảnh tham chiếu nếu có.
8. Cài mới trên Windows, cập nhật từ phiên bản cũ có dữ liệu bằng bộ cài thủ công và updater; kiểm tra dữ liệu còn nguyên. Thử mất mạng, tải dở, sai chữ ký, không có bản mới và migration lỗi. Không ghi “đã kiểm thử cập nhật” nếu mới chỉ mock phản hồi.
9. Kiểm tra gỡ/cài lại theo tùy chọn giữ dữ liệu; kiểm tra bản sao trước cập nhật thực sự khôi phục được. Không chạy kiểm thử phá dữ liệu trên ghi chú thật của người dùng.
10. Kiểm tra backup tự động khi app đang chạy, chạy bù sau ngày bỏ lỡ, hết dung lượng và dọn bản cũ; không xóa backup tốt cuối cùng khi bản mới chưa hoàn tất.

Bàn giao mã nguồn, hướng dẫn chạy/build và bảo trì phát hành, bộ cài Windows nếu môi trường hỗ trợ, định dạng backup có tài liệu, hướng dẫn cập nhật/chuyển máy bằng tiếng Việt, kết quả kiểm thử và danh sách giới hạn. Nếu môi trường chưa build/test được Windows, nói rõ và cung cấp quy trình cần chạy trên Windows; không giả tạo tệp .exe hoặc tuyên bố bản cài đã kiểm thử. Không tự công khai tài liệu cá nhân. Bắt đầu triển khai ngay.
