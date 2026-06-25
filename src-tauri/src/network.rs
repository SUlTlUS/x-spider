use reqwest::Method;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Default, serde::Serialize)]
pub struct Response {
    status: u16,
    headers: HashMap<String, Vec<String>>,
    body: Value,
}

#[tauri::command]
pub async fn network_fetch(
    method: String,
    url: String,
    body: String,
    enable_proxy: bool,
    proxy_url: String,
    response_type: String,
    headers: HashMap<String, String>,
) -> Result<Response, String> {
    let map_reqwest_err = |err: reqwest::Error| err.to_string();
    // Convert method string into Method
    let method: Method = match method.to_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PATCH" => Ok(Method::PATCH),
        "PUT" => Ok(Method::PUT),
        "DELETE" => Ok(Method::DELETE),
        "HEAD" => Ok(Method::HEAD),
        _ => Err("Invalid method".to_string()),
    }?;

    // Build client
    let client = {
        let mut b = reqwest::Client::builder();

        // Auto set proxy settings
        if enable_proxy {
            if proxy_url.len() == 0 {
                // Use system proxy, do nothing
            } else {
                // Use custom proxy url
                let proxy_http = reqwest::Proxy::http(proxy_url.clone())
                    .or(Err("Failed to set proxy url".to_string()))?;
                let proxy_https = reqwest::Proxy::https(proxy_url.clone())
                    .or(Err("Failed to set proxy url".to_string()))?;
                b = b.proxy(proxy_http).proxy(proxy_https);
            }
        } else {
            // No proxy
            b = b.no_proxy();
        }

        b.build()
            .or(Err("Failed to build reqwest client".to_string()))
    }?;

    // Build request
    let request = {
        let mut req = client.request(method.clone(), url);
        for (k, v) in headers {
            req = req.header(k, v);
        }

        if !matches!(method.clone(), Method::GET) {
            req = req.body(body);
        }

        req
    };

    // Send request
    let response = request.send().await.map_err(map_reqwest_err)?;

    // Extract some info
    let status = response.status().as_u16();
    let resp_headers = {
        let reqwest_headers = response.headers();
        let mut h: HashMap<String, Vec<String>> = HashMap::with_capacity(reqwest_headers.len());

        for (k, v) in reqwest_headers {
            let v = v.to_str();
            if let Err(_) = v {
                continue;
            }

            let v = v.unwrap().to_string();
            h.entry(k.to_string())
                .and_modify(|arr: &mut Vec<String>| arr.push(v.clone()))
                .or_insert_with(|| vec![v]);
        }

        h
    };

    // Load response body
    let body: Value = {
        match response_type.as_str() {
            "json" => response
                .json()
                .await
                .map_err(map_reqwest_err)
                .map(|res| Value::Object(res)),
            "text" => response
                .text()
                .await
                .map_err(map_reqwest_err)
                .map(|res| Value::String(res)),
            "binary" => {
                let bytes = response.bytes().await.map_err(map_reqwest_err)?;
                serde_json::to_value(bytes.to_vec()).map_err(|err| err.to_string())
            }
            _ => Err("Unsupported response type".to_string()),
        }
    }?;

    return Ok(Response {
        status,
        body,
        headers: resp_headers,
    });
}

#[tauri::command]
pub async fn network_get_system_proxy_url() -> Result<HashMap<String, String>, ()> {
    Ok(get_system_proxy_map())
}

fn get_system_proxy_map() -> HashMap<String, String> {
    let mut proxies = get_system_proxy_from_platform();
    if proxies.is_empty() {
        proxies = get_system_proxy_from_env();
    }

    proxies
}

#[cfg(target_os = "windows")]
fn get_system_proxy_from_platform() -> HashMap<String, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let proxies = HashMap::new();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let internet_settings =
        match hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings") {
            Ok(key) => key,
            Err(_) => return proxies,
        };

    let proxy_enable = internet_settings
        .get_value::<u32, _>("ProxyEnable")
        .unwrap_or(0);
    if proxy_enable == 0 {
        return proxies;
    }

    let proxy_server = match internet_settings.get_value::<String, _>("ProxyServer") {
        Ok(value) => value,
        Err(_) => return proxies,
    };

    parse_proxy_server(&proxy_server)
}

#[cfg(not(target_os = "windows"))]
fn get_system_proxy_from_platform() -> HashMap<String, String> {
    HashMap::new()
}

fn get_system_proxy_from_env() -> HashMap<String, String> {
    let mut proxies = HashMap::new();

    if let Ok(value) = std::env::var("HTTP_PROXY").or_else(|_| std::env::var("http_proxy")) {
        if let Some(value) = normalize_proxy_value(&value) {
            proxies.insert("http".to_string(), value);
        }
    }

    if let Ok(value) = std::env::var("HTTPS_PROXY").or_else(|_| std::env::var("https_proxy")) {
        if let Some(value) = normalize_proxy_value(&value) {
            proxies.insert("https".to_string(), value);
        }
    }

    proxies
}

fn parse_proxy_server(value: &str) -> HashMap<String, String> {
    let mut proxies = HashMap::new();

    for part in value
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        if let Some((scheme, proxy)) = part.split_once('=') {
            if let Some(proxy) = normalize_proxy_value(proxy) {
                let scheme = scheme.to_ascii_lowercase();
                if scheme == "http" || scheme == "https" {
                    proxies.insert(scheme, proxy);
                }
            }
        } else if let Some(proxy) = normalize_proxy_value(part) {
            proxies.insert("http".to_string(), proxy.clone());
            proxies.insert("https".to_string(), proxy);
        }
    }

    proxies
}

fn normalize_proxy_value(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    let authority = value
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(value)
        .split('/')
        .next()
        .unwrap_or(value)
        .trim();

    if authority.is_empty() {
        None
    } else {
        Some(authority.to_string())
    }
}
