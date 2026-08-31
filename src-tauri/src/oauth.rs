use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;
use url::Url;

#[derive(Debug, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: i32,
    pub token_type: String,
}

pub fn start_local_server() -> Result<(String, mpsc::Receiver<String>), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/oauth2callback", port);

    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        listener.set_nonblocking(true).ok();
        let start = std::time::Instant::now();

        loop {
            if start.elapsed().as_secs() > 120 {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0; 2048];
                    if let Ok(size) = stream.read(&mut buffer) {
                        let request = String::from_utf8_lossy(&buffer[..size]);
                        let first_line = request.lines().next().unwrap_or("");

                        if first_line.starts_with("GET ") {
                            let parts: Vec<&str> = first_line.split_whitespace().collect();
                            if parts.len() > 1 {
                                let path = parts[1];
                                if let Ok(url) = Url::parse(&format!("http://localhost{}", path)) {
                                    let mut code = None;
                                    for (k, v) in url.query_pairs() {
                                        if k == "code" {
                                            code = Some(v.into_owned());
                                        }
                                    }

                                    if let Some(c) = code {
                                        let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><h1>Dang nhap thanh cong!</h1><p>Ban co the dong the nay va quay tro lai ung dung Notes.</p><script>window.close();</script></body></html>";
                                        stream.write_all(response.as_bytes()).ok();
                                        tx.send(c).ok();
                                        break;
                                    } else {
                                        let response = "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\n\r\n<html><body><h1>Loi dang nhap</h1><p>Khong tim thay ma code.</p></body></html>";
                                        stream.write_all(response.as_bytes()).ok();
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(_) => {
                    break;
                }
            }
        }
    });

    Ok((redirect_uri, rx))
}

pub async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::new();
    let params = [
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];

    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if res.status().is_success() {
        let tokens: OAuthTokens = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;
        Ok(tokens)
    } else {
        let err_text = res.text().await.unwrap_or_default();
        Err(format!("OAuth error: {}", err_text))
    }
}
