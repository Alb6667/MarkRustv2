//! Explicit, bounded raster-image downloads. This is deliberately not a
//! general-purpose HTTP client for the webview.
use std::{
    io::{Cursor, Read},
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{ImageFormat, ImageReader, Limits};
use reqwest::{
    blocking::{Client, ClientBuilder, Response},
    header::{ACCEPT, CONTENT_TYPE, LOCATION},
    redirect::Policy,
    StatusCode,
};
use url::{Host, Url};

const MAX_URL_BYTES: usize = 4096;
const MAX_REDIRECTS: usize = 3;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8192;
const MAX_DECODED_BYTES: u64 = 128 * 1024 * 1024;

fn public_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    // Keep this explicit instead of relying on the still-unstable is_global()
    // std APIs. Unknown/special ranges fail closed; ordinary public unicast
    // addresses remain usable.
    if a == 0 || a >= 224 || a == 10 || a == 127 || (a == 169 && b == 254) ||
        (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168) ||
        (a == 100 && (64..=127).contains(&b)) || (a == 198 && (b == 18 || b == 19)) {
        return false;
    }
    // IETF assignments, documentation, benchmarking and 6to4-relay ranges.
    if (a == 192 && b == 0 && (c == 0 || c == 2)) ||
        (a == 192 && b == 88 && c == 99) || (a == 198 && b == 51 && c == 100) ||
        (a == 203 && b == 0 && c == 113) {
        return false;
    }
    true
}

fn public_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4() {
        return public_ipv4(v4);
    }
    let s = ip.segments();
    // Unspecified/IPv4-compatible, unique-local, link-local and multicast.
    if (s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0 && s[4] == 0) ||
        (s[0] & 0xfe00 == 0xfc00) ||
        (s[0] & 0xffc0 == 0xfe80) || (s[0] & 0xff00 == 0xff00) {
        return false;
    }
    // Documentation, benchmarking, ORCHID, Teredo, 6to4, NAT64 and discard.
    // These transitions are deliberately rejected rather than trying to
    // unwrap every possible embedded address scheme.
    if (s[0] == 0x2001 && (s[1] == 0x0db8 || s[1] == 0 || s[1] == 2 ||
        (s[1] & 0xfff0 == 0x10) || (s[1] & 0xfff0 == 0x20))) ||
        s[0] == 0x2002 || (s[0] == 0x64 && s[1] == 0xff9b) ||
        (s[0] == 0x100 && s[1] == 0 && s[2] == 0 && s[3] == 0) {
        return false;
    }
    true
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_ipv4(v4),
        IpAddr::V6(v6) => public_ipv6(v6),
    }
}

fn validate_addresses(addrs: &[SocketAddr]) -> Result<(), String> {
    if addrs.is_empty() || addrs.iter().any(|addr| !public_ip(addr.ip())) {
        return Err("Alamat tujuan gambar bukan alamat publik yang diizinkan".into());
    }
    Ok(())
}

fn parse_image_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_URL_BYTES {
        return Err("URL gambar kosong atau terlalu panjang".into());
    }
    let normalized = if raw.starts_with("//") { format!("https:{raw}") } else { raw.to_string() };
    let url = Url::parse(&normalized).map_err(|_| "URL gambar tidak valid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Hanya gambar http/https yang dapat diunduh".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL gambar tidak boleh membawa kredensial".into());
    }
    match url.host() {
        Some(Host::Domain(domain)) => {
            if domain.eq_ignore_ascii_case("localhost") || domain.to_ascii_lowercase().ends_with(".localhost") {
                return Err("Host lokal tidak diizinkan".into());
            }
        }
        Some(Host::Ipv4(ip)) if !public_ip(IpAddr::V4(ip)) => {
            return Err("Alamat IP privat/lokal tidak diizinkan".into());
        }
        Some(Host::Ipv6(ip)) if !public_ip(IpAddr::V6(ip)) => {
            return Err("Alamat IP privat/lokal tidak diizinkan".into());
        }
        None => return Err("URL gambar harus memiliki host".into()),
        _ => {}
    }
    if url.port_or_known_default().is_none() {
        return Err("Port tujuan gambar tidak valid".into());
    }
    Ok(url)
}

fn pin_validated_destination(mut builder: ClientBuilder, url: &Url) -> Result<ClientBuilder, String> {
    let port = url.port_or_known_default().ok_or("Port tujuan tidak valid")?;
    match url.host() {
        Some(Host::Domain(domain)) => {
            let addrs = (domain, port).to_socket_addrs()
                .map_err(|e| format!("DNS gambar gagal: {e}"))?
                .collect::<Vec<_>>();
            // Reject the whole answer if even one route is non-public. Pinning
            // prevents reqwest from resolving the name again (DNS rebinding).
            validate_addresses(&addrs)?;
            builder = builder.resolve_to_addrs(domain, &addrs);
        }
        Some(Host::Ipv4(ip)) => validate_addresses(&[SocketAddr::new(IpAddr::V4(ip), port)])?,
        Some(Host::Ipv6(ip)) => validate_addresses(&[SocketAddr::new(IpAddr::V6(ip), port)])?,
        None => return Err("URL gambar harus memiliki host".into()),
    }
    Ok(builder)
}

fn send_once(url: &Url) -> Result<Response, String> {
    let builder = Client::builder()
        .redirect(Policy::none())
        // Reqwest does not persist cookies unless a cookie store is enabled;
        // this client never enables one and is rebuilt for every redirect.
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .user_agent("MarkRust/0.1 (explicit image fetch)");
    // A fresh client is used for every redirect: no cookie/session forwarding.
    // Proxy use is disabled so it cannot bypass destination validation.
    let builder = pin_validated_destination(builder, url)?;
    let client = builder.build().map_err(|e| format!("HTTP client gagal: {e}"))?;
    client.get(url.clone())
        .header(ACCEPT, "image/png,image/jpeg,image/gif,image/webp")
        .send()
        .map_err(|e| format!("Unduhan gambar gagal: {e}"))
}

fn read_limited(reader: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader.take(limit.saturating_add(1)).read_to_end(&mut bytes)
        .map_err(|e| format!("Gagal membaca gambar: {e}"))?;
    if bytes.len() as u64 > limit {
        return Err("Gambar melebihi batas ukuran".into());
    }
    Ok(bytes)
}

fn validate_image_bytes(bytes: &[u8], content_type: Option<&str>) -> Result<&'static str, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Format gambar tidak dapat dibaca: {e}"))?;
    let format = reader.format();
    let mime = match format {
        Some(ImageFormat::Png) => "image/png",
        Some(ImageFormat::Jpeg) => "image/jpeg",
        Some(ImageFormat::Gif) => "image/gif",
        Some(ImageFormat::WebP) => "image/webp",
        _ => return Err("Hanya PNG, JPEG, GIF, atau WebP yang diizinkan; SVG ditolak".into()),
    };
    if let Some(header) = content_type {
        let declared = header.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        let matches = declared == mime || (format == Some(ImageFormat::Jpeg) && declared == "image/jpg");
        if !matches {
            return Err("Content-Type tidak cocok dengan isi gambar".into());
        }
    }

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    reader.limits(limits);
    // Decode once natively. This rejects truncated/polyglot payloads that only
    // have a plausible image header and applies decompression/resource limits.
    reader.decode().map_err(|e| format!("Isi gambar tidak valid atau terlalu besar: {e}"))?;
    Ok(mime)
}

fn fetch_image_blocking(raw: &str) -> Result<String, String> {
    let mut current = parse_image_url(raw)?;
    for redirect_count in 0..=MAX_REDIRECTS {
        let response = send_once(&current)?;
        if matches!(response.status(), StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND |
            StatusCode::SEE_OTHER | StatusCode::TEMPORARY_REDIRECT | StatusCode::PERMANENT_REDIRECT) {
            if redirect_count == MAX_REDIRECTS {
                return Err("Terlalu banyak redirect gambar".into());
            }
            let location = response.headers().get(LOCATION)
                .ok_or("Redirect gambar tanpa Location")?
                .to_str().map_err(|_| "Location redirect tidak valid")?
                .to_owned();
            let next = current.join(&location).map_err(|_| "URL redirect tidak valid")?;
            drop(response);
            // Every redirect gets full scheme/credential/DNS/IP validation.
            current = parse_image_url(next.as_str())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("Server gambar mengembalikan HTTP {}", response.status().as_u16()));
        }
        if response.content_length().is_some_and(|len| len > MAX_IMAGE_BYTES) {
            return Err("Gambar melebihi batas 8 MiB".into());
        }
        let content_type = response.headers().get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()).map(str::to_owned);
        let bytes = read_limited(response, MAX_IMAGE_BYTES)?;
        let mime = validate_image_bytes(&bytes, content_type.as_deref())?;
        return Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
    }
    Err("Unduhan gambar berakhir tanpa respons valid".into())
}

#[tauri::command]
pub async fn fetch_image(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_image_blocking(&url))
        .await
        .map_err(|e| format!("Tugas unduhan gambar gagal: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use std::io::Cursor;

    #[test]
    fn unsafe_schemes_credentials_and_literal_ips_are_rejected() {
        for raw in [
            "file:///etc/passwd", "data:image/png;base64,AA", "https://user:pass@example.com/a.png",
            "http://127.0.0.1/a.png", "http://10.0.0.1/a.png", "http://169.254.169.254/meta",
            "http://100.64.0.1/a.png", "http://[::1]/a.png", "http://[fc00::1]/a.png",
            "http://[fe80::1]/a.png", "http://[::ffff:127.0.0.1]/a.png", "//localhost/a.png",
            "http://[2001:db8::1]/a.png", "http://[2002::1]/a.png", "http://[64:ff9b::7f00:1]/a.png",
            "http://192.0.2.1/a.png", "http://198.18.0.1/a.png", "http://224.0.0.1/a.png",
        ] {
            assert!(parse_image_url(raw).is_err(), "should reject {raw}");
        }
        assert!(parse_image_url("https://example.com/a.png").is_ok());
        assert!(parse_image_url("https://8.8.8.8/a.png").is_ok());
        assert!(parse_image_url("https://[2606:4700:4700::1111]/a.png").is_ok());
        assert_eq!(parse_image_url("//example.com/a.png").unwrap().scheme(), "https");
    }

    #[test]
    fn every_resolved_route_must_be_public() {
        let public: SocketAddr = "8.8.8.8:443".parse().unwrap();
        let private: SocketAddr = "192.168.1.1:443".parse().unwrap();
        assert!(validate_addresses(&[public]).is_ok());
        assert!(validate_addresses(&[public, private]).is_err());
        assert!(validate_addresses(&[]).is_err());
    }

    #[test]
    fn streaming_limit_rejects_the_byte_after_the_cap() {
        assert_eq!(read_limited(Cursor::new(b"1234"), 4).unwrap(), b"1234");
        assert!(read_limited(Cursor::new(b"12345"), 4).is_err());
    }

    #[test]
    fn raster_content_is_decoded_and_svg_or_mime_mismatch_is_rejected() {
        let png = STANDARD.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        ).unwrap();
        assert_eq!(validate_image_bytes(&png, Some("image/png; charset=binary")).unwrap(), "image/png");
        assert!(validate_image_bytes(&png, Some("image/jpeg")).is_err());
        assert!(validate_image_bytes(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>", Some("image/svg+xml")).is_err());
        assert!(validate_image_bytes(b"not an image", Some("image/png")).is_err());
        assert!(validate_image_bytes(&png[..20], Some("image/png")).is_err());
    }
}
