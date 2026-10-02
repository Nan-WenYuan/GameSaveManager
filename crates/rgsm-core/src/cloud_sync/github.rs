//! GitHub Contents storage scoped to the dedicated saves branch.
//! No Git installation is required; credentials remain in the local owner store.
use std::{collections::VecDeque, fmt, sync::Arc};

use base64::{Engine, engine::general_purpose::STANDARD};
use opendal::{Buffer, Capability, EntryMode, Error, ErrorKind, Metadata, Operator, raw::*};
use reqwest::{Client, Method, StatusCode, Url};
use serde_json::{Value, json};

const MAX_FILE_SIZE: usize = 100 * 1024 * 1024;

#[derive(Clone)]
struct GithubStorage {
    client: Client,
    endpoint: Url,
    branch: String,
    root: String,
    token: String,
    info: Arc<AccessorInfo>,
    writes: Arc<tokio::sync::Mutex<()>>,
}

impl fmt::Debug for GithubStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GithubStorage")
            .field("branch", &self.branch)
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

// Existing personal settings must never send save credentials to the public source repository.
fn save_repository<'a>(owner: &str, repository: &'a str, branch: &str) -> &'a str {
    if owner.eq_ignore_ascii_case("Nan-WenYuan")
        && repository.eq_ignore_ascii_case("GameSaveManager")
        && branch == "saves"
    {
        "Game_Data"
    } else {
        repository
    }
}

pub(super) fn operator(
    owner: &str,
    repository: &str,
    branch: &str,
    token: &str,
    root: &str,
) -> opendal::Result<Operator> {
    if !valid_repository_component(owner)
        || !valid_repository_component(repository)
        || branch != "saves"
    {
        return Err(Error::new(
            ErrorKind::ConfigInvalid,
            "GitHub owner/repository is invalid or branch is not saves",
        ));
    }
    if token.trim().is_empty() || token.contains(['\r', '\n']) {
        return Err(Error::new(
            ErrorKind::ConfigInvalid,
            "A GitHub token with repository Contents read/write permission is required",
        ));
    }
    let root = root.trim_matches('/');
    validate_path(root)?;
    let repository = save_repository(owner, repository, branch);
    let endpoint = Url::parse(&format!(
        "https://api.github.com/repos/{owner}/{repository}/"
    ))
    .map_err(|_| Error::new(ErrorKind::ConfigInvalid, "Invalid GitHub repository"))?;
    let info = AccessorInfo::default();
    info.set_scheme("github")
        .set_root(root)
        .set_native_capability(Capability {
            stat: true,
            read: true,
            write: true,
            write_can_empty: true,
            delete: true,
            list: true,
            list_with_recursive: true,
            shared: true,
            ..Default::default()
        });
    let client = Client::builder()
        .user_agent("game-save-manager")
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|_| {
            Error::new(
                ErrorKind::Unexpected,
                "Cannot initialize GitHub HTTP client",
            )
        })?;
    Ok(Operator::from_inner(Arc::new(GithubStorage {
        client,
        endpoint,
        branch: branch.into(),
        root: root.into(),
        token: token.trim().into(),
        info: info.into(),
        writes: Arc::new(tokio::sync::Mutex::new(())),
    })))
}

fn valid_repository_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

fn validate_path(path: &str) -> opendal::Result<()> {
    if path.contains(['\\', '\0']) || path.split('/').any(|part| part == "." || part == "..") {
        return Err(Error::new(
            ErrorKind::ConfigInvalid,
            "GitHub storage path contains invalid segments",
        ));
    }
    Ok(())
}

fn response_error(status: StatusCode) -> Error {
    let kind = match status {
        StatusCode::NOT_FOUND => ErrorKind::NotFound,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ErrorKind::PermissionDenied,
        StatusCode::CONFLICT | StatusCode::UNPROCESSABLE_ENTITY => ErrorKind::ConditionNotMatch,
        _ => ErrorKind::Unexpected,
    };
    // Response bodies can contain repository details. Never include tokens or URLs.
    Error::new(
        kind,
        format!(
            "GitHub request failed (HTTP {}); check Contents permissions, saves branch, rate limits or concurrent changes",
            status.as_u16()
        ),
    )
}

impl GithubStorage {
    fn remote_path(&self, path: &str) -> opendal::Result<String> {
        validate_path(path)?;
        Ok([self.root.as_str(), path.trim_matches('/')]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("/"))
    }

    fn url(&self, prefix: &str, path: &str) -> opendal::Result<Url> {
        let mut url = self.endpoint.clone();
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| Error::new(ErrorKind::ConfigInvalid, "Invalid GitHub API URL"))?;
        segments.pop_if_empty().push(prefix);
        for part in path.split('/').filter(|part| !part.is_empty()) {
            segments.push(part);
        }
        drop(segments);
        Ok(url)
    }

    async fn request(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
        raw: bool,
    ) -> opendal::Result<reqwest::Response> {
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&self.token)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header(
                "Accept",
                if raw {
                    "application/vnd.github.raw+json"
                } else {
                    "application/vnd.github+json"
                },
            );
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(body.to_string());
        }
        let response = request
            .send()
            .await
            .map_err(|_| Error::new(ErrorKind::Unexpected, "GitHub network request failed"))?;
        if !response.status().is_success() {
            return Err(response_error(response.status()));
        }
        Ok(response)
    }

    async fn contents(&self, path: &str) -> opendal::Result<Value> {
        let mut url = self.url("contents", &self.remote_path(path)?)?;
        url.query_pairs_mut().append_pair("ref", &self.branch);
        let bytes = self
            .request(Method::GET, url, None, false)
            .await?
            .bytes()
            .await
            .map_err(|_| Error::new(ErrorKind::Unexpected, "GitHub response could not be read"))?;
        serde_json::from_slice(&bytes)
            .map_err(|_| Error::new(ErrorKind::Unexpected, "Invalid GitHub contents response"))
    }

    async fn existing_sha(&self, path: &str) -> opendal::Result<Option<String>> {
        match self.contents(path).await {
            Ok(value) => value["sha"]
                .as_str()
                .map(|s| Some(s.into()))
                .ok_or_else(|| Error::new(ErrorKind::IsADirectory, "GitHub path is not a file")),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[derive(Debug)]
struct GithubWriter {
    storage: GithubStorage,
    path: String,
    sha: Option<String>,
}

impl oio::OneShotWrite for GithubWriter {
    async fn write_once(&self, buffer: Buffer) -> opendal::Result<Metadata> {
        if buffer.len() >= MAX_FILE_SIZE {
            return Err(Error::new(
                ErrorKind::Unsupported,
                "GitHub backups must be smaller than 100 MiB; use another cloud backend for larger files",
            ));
        }
        let _guard = self.storage.writes.lock().await;
        let mut body = json!({"message": "Update game save backup", "branch": self.storage.branch, "content": STANDARD.encode(buffer.to_vec())});
        if let Some(sha) = &self.sha {
            body["sha"] = sha.clone().into();
        }
        self.storage
            .request(
                Method::PUT,
                self.storage
                    .url("contents", &self.storage.remote_path(&self.path)?)?,
                Some(body),
                false,
            )
            .await?;
        let mut metadata = Metadata::new(EntryMode::FILE);
        metadata.set_content_length(buffer.len() as u64);
        Ok(metadata)
    }
}

#[derive(Debug)]
struct GithubDeleter(GithubStorage);
impl oio::OneShotDelete for GithubDeleter {
    async fn delete_once(&self, path: String, _: OpDelete) -> opendal::Result<()> {
        let _guard = self.0.writes.lock().await;
        let Some(sha) = self.0.existing_sha(&path).await? else {
            return Ok(());
        };
        self.0.request(Method::DELETE, self.0.url("contents", &self.0.remote_path(&path)?)?, Some(json!({"message":"Remove game save backup", "branch": self.0.branch, "sha":sha})), false).await?;
        Ok(())
    }
}

struct GithubLister(VecDeque<oio::Entry>);
impl oio::List for GithubLister {
    async fn next(&mut self) -> opendal::Result<Option<oio::Entry>> {
        Ok(self.0.pop_front())
    }
}

impl Access for GithubStorage {
    type Reader = oio::Reader;
    type Writer = oio::Writer;
    type Lister = oio::Lister;
    type Deleter = oio::Deleter;
    type Copier = oio::Copier;
    fn info(&self) -> Arc<AccessorInfo> {
        self.info.clone()
    }

    async fn stat(&self, path: &str, _: OpStat) -> opendal::Result<RpStat> {
        if path == "/" {
            return Ok(RpStat::new(Metadata::new(EntryMode::DIR)));
        }
        let value = self.contents(path).await?;
        if value.is_array() {
            return Ok(RpStat::new(Metadata::new(EntryMode::DIR)));
        }
        let mut metadata = Metadata::new(EntryMode::FILE);
        metadata.set_content_length(value["size"].as_u64().unwrap_or(0));
        if let Some(sha) = value["sha"].as_str() {
            metadata.set_etag(sha);
        }
        Ok(RpStat::new(metadata))
    }

    async fn read(&self, path: &str, args: OpRead) -> opendal::Result<(RpRead, Self::Reader)> {
        let mut url = self.url("contents", &self.remote_path(path)?)?;
        url.query_pairs_mut().append_pair("ref", &self.branch);
        let bytes = self
            .request(Method::GET, url, None, true)
            .await?
            .bytes()
            .await
            .map_err(|_| Error::new(ErrorKind::Unexpected, "GitHub file download failed"))?;
        let offset = args.range().offset() as usize;
        if offset > bytes.len() {
            return Err(Error::new(
                ErrorKind::RangeNotSatisfied,
                "Requested range exceeds GitHub file size",
            ));
        }
        let end = args
            .range()
            .size()
            .map(|size| offset.saturating_add(size as usize).min(bytes.len()))
            .unwrap_or(bytes.len());
        let mut metadata = Metadata::new(EntryMode::FILE);
        metadata.set_content_length((end - offset) as u64);
        Ok((
            RpRead::new(metadata),
            Box::new(Buffer::from(bytes.slice(offset..end))),
        ))
    }

    async fn write(&self, path: &str, _: OpWrite) -> opendal::Result<(RpWrite, Self::Writer)> {
        let sha = self.existing_sha(path).await?;
        Ok((
            RpWrite::new(),
            Box::new(oio::OneShotWriter::new(GithubWriter {
                storage: self.clone(),
                path: path.into(),
                sha,
            })),
        ))
    }

    async fn delete(&self) -> opendal::Result<(RpDelete, Self::Deleter)> {
        Ok((
            RpDelete::default(),
            Box::new(oio::OneShotDeleter::new(GithubDeleter(self.clone()))),
        ))
    }

    async fn list(&self, path: &str, args: OpList) -> opendal::Result<(RpList, Self::Lister)> {
        // Trees API avoids the Contents API's 1,000 entries per-directory limit.
        let mut url = self.url("git", &format!("trees/{}", self.branch))?;
        url.query_pairs_mut().append_pair("recursive", "1");
        let bytes = self
            .request(Method::GET, url, None, false)
            .await?
            .bytes()
            .await
            .map_err(|_| {
                Error::new(
                    ErrorKind::Unexpected,
                    "GitHub tree response could not be read",
                )
            })?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Error::new(ErrorKind::Unexpected, "Invalid GitHub tree response"))?;
        if value["truncated"].as_bool() == Some(true) {
            return Err(Error::new(
                ErrorKind::Unsupported,
                "GitHub save tree is too large to list safely",
            ));
        }
        let prefix = self.remote_path(if path == "." { "/" } else { path })?;
        let prefix = if prefix.is_empty() {
            String::new()
        } else {
            format!("{prefix}/")
        };
        let root_prefix = if self.root.is_empty() {
            String::new()
        } else {
            format!("{}/", self.root)
        };
        let mut entries = VecDeque::new();
        let tree = value["tree"].as_array().ok_or_else(|| {
            Error::new(ErrorKind::Unexpected, "GitHub response is missing the tree")
        })?;
        for item in tree {
            let Some(remote) = item["path"].as_str() else {
                continue;
            };
            let Some(tail) = remote.strip_prefix(&prefix) else {
                continue;
            };
            if !args.recursive() && tail.contains('/') {
                continue;
            }
            let Some(relative) = remote.strip_prefix(&root_prefix) else {
                continue;
            };
            let directory = item["type"] == "tree";
            let mut metadata = Metadata::new(if directory {
                EntryMode::DIR
            } else {
                EntryMode::FILE
            });
            metadata.set_content_length(item["size"].as_u64().unwrap_or(0));
            entries.push_back(oio::Entry::new(
                &format!("{relative}{}", if directory { "/" } else { "" }),
                metadata,
            ));
        }
        Ok((RpList::default(), Box::new(GithubLister(entries))))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn migration_routes_only_existing_owner_saves_to_private_data() {
        assert_eq!(
            super::save_repository("Nan-WenYuan", "GameSaveManager", "saves"),
            "Game_Data"
        );
        assert_eq!(
            super::save_repository("other", "GameSaveManager", "saves"),
            "GameSaveManager"
        );
        assert_eq!(
            super::save_repository("Nan-WenYuan", "GameSaveManager", "main"),
            "GameSaveManager"
        );
        assert_eq!(
            super::save_repository("Nan-WenYuan", "custom", "saves"),
            "custom"
        );
    }

    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn mocked_storage(
        responses: Vec<(u16, Vec<u8>)>,
    ) -> (Operator, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert!(read > 0);
                    request.extend_from_slice(&chunk[..read]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&request[..end]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|s| s.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(request).unwrap());
                let header = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(&body).await.unwrap();
            }
            requests
        });
        let storage = GithubStorage {
            client: Client::builder().no_proxy().build().unwrap(),
            endpoint: Url::parse(&format!("http://{address}/repos/owner/repository/")).unwrap(),
            root: "backups".into(),
            branch: "saves".into(),
            token: "test-token".into(),
            info: operator("owner", "repository", "saves", "test-token", "backups")
                .unwrap()
                .inner()
                .info(),
            writes: Arc::new(tokio::sync::Mutex::new(())),
        };
        (Operator::from_inner(Arc::new(storage)), handle)
    }

    #[tokio::test]
    async fn contents_crud_preserves_archive_bytes_and_uses_only_saves_branch() {
        let sha = br#"{"sha":"previous-sha","size":3}"#.to_vec();
        let tree = br#"{"truncated":false,"tree":[{"path":"backups/game/old.zip","type":"blob","size":3},{"path":"source.rs","type":"blob","size":1}]}"#.to_vec();
        let (op, server) = mocked_storage(vec![
            (200, sha.clone()),
            (200, b"{}".to_vec()),
            (200, b"ZIP".to_vec()),
            (200, tree),
            (200, sha),
            (200, b"{}".to_vec()),
        ])
        .await;
        op.write("game/old.zip", "ZIP").await.unwrap();
        assert_eq!(op.read("game/old.zip").await.unwrap().to_vec(), b"ZIP");
        let listed = op.list_with("/").recursive(true).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path(), "game/old.zip");
        op.delete("game/old.zip").await.unwrap();
        let requests = tokio::time::timeout(std::time::Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        assert!(
            requests[0].starts_with(
                "GET /repos/owner/repository/contents/backups/game/old.zip?ref=saves "
            )
        );
        let body: Value =
            serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["branch"], "saves");
        assert_eq!(body["sha"], "previous-sha");
        assert_eq!(body["content"], STANDARD.encode(b"ZIP"));
        assert!(
            requests[3].starts_with("GET /repos/owner/repository/git/trees/saves?recursive=1 ")
        );
        let body: Value =
            serde_json::from_str(requests[5].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["branch"], "saves");
        assert_eq!(body["sha"], "previous-sha");
    }

    #[tokio::test]
    async fn rejects_incomplete_listing_and_concurrent_write_conflicts() {
        let (op, server) =
            mocked_storage(vec![(200, br#"{"truncated":true,"tree":[]}"#.to_vec())]).await;
        assert_eq!(
            op.list("/").await.unwrap_err().kind(),
            ErrorKind::Unsupported
        );
        server.await.unwrap();
        let (op, server) = mocked_storage(vec![
            (200, br#"{"sha":"old"}"#.to_vec()),
            (409, b"{}".to_vec()),
        ])
        .await;
        assert_eq!(
            op.write("metadata.json", "new").await.unwrap_err().kind(),
            ErrorKind::ConditionNotMatch
        );
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[test]
    fn github_configuration_is_sanitized() {
        use crate::preclude::Sanitizable;
        let backend = super::super::Backend::GitHub {
            owner: "owner".into(),
            repository: "repository".into(),
            branch: "saves".into(),
            token: "secret-token".into(),
        };
        let encoded = serde_json::to_string(&backend.sanitize()).unwrap();
        assert!(!encoded.contains("secret-token"));
        assert!(encoded.contains("*token*"));
    }
    #[test]
    fn rejects_code_branches_and_path_injection() {
        for branch in ["personal-dev", "upstream-dev", "main", ""] {
            assert!(operator("owner", "repo", branch, "secret", "/").is_err());
        }
        for root in ["../source", "a/../b", "a\\b"] {
            assert!(operator("owner", "repo", "saves", "secret", root).is_err());
        }
        assert!(operator("owner/name", "repo", "saves", "secret", "/").is_err());
    }
    #[test]
    fn network_errors_do_not_expose_secrets_and_conflicts_are_not_retried() {
        let error = response_error(StatusCode::CONFLICT);
        assert_eq!(error.kind(), ErrorKind::ConditionNotMatch);
        assert!(!error.is_temporary());
        assert_eq!(
            response_error(StatusCode::UNAUTHORIZED).kind(),
            ErrorKind::PermissionDenied
        );
    }
}
