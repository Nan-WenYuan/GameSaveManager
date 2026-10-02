//! Serialize desktop initialization until the single-instance message target exists.
//! The Tauri plugin owns the lifetime singleton; this guard covers its startup race.

#[cfg(windows)]
pub struct StartupGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
    // Windows mutex ownership belongs to the acquiring thread.
    _same_thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[cfg(not(windows))]
pub struct StartupGuard;

#[cfg(not(windows))]
impl Drop for StartupGuard {
    fn drop(&mut self) {}
}

pub fn acquire(http_host_only: bool, identifier: &str) -> std::io::Result<Option<StartupGuard>> {
    if http_host_only {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        StartupGuard::acquire_named(&format!("Local\\{identifier}-desktop-startup")).map(Some)
    }
    #[cfg(not(windows))]
    {
        let _ = identifier;
        Ok(None)
    }
}

#[cfg(windows)]
impl StartupGuard {
    fn acquire_named(name: &str) -> std::io::Result<Self> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{CreateMutexW, WaitForSingleObject},
        };
        let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let result = unsafe { WaitForSingleObject(handle, 60_000) };
        if result != WAIT_OBJECT_0 && result != WAIT_ABANDONED {
            let reason = if result == WAIT_TIMEOUT {
                std::io::ErrorKind::TimedOut.into()
            } else {
                std::io::Error::last_os_error()
            };
            unsafe { CloseHandle(handle) };
            return Err(reason);
        }
        Ok(Self {
            handle,
            _same_thread: std::marker::PhantomData,
        })
    }
}

#[cfg(windows)]
impl Drop for StartupGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::ReleaseMutex};
        unsafe {
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        process::Command,
        time::{Duration, Instant},
    };

    fn wait_ready(path: &std::path::Path) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "startup mutex child did not become ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn child(name: &str, ready: &std::path::Path, hold_ms: u64) -> std::process::Child {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "startup::tests::startup_mutex_child",
                "--ignored",
            ])
            .env("RGSM_TEST_STARTUP_MUTEX", name)
            .env("RGSM_TEST_STARTUP_READY", ready)
            .env("RGSM_TEST_STARTUP_HOLD_MS", hold_ms.to_string())
            .spawn()
            .unwrap()
    }

    #[test]
    fn http_only_hosts_bypass_the_desktop_startup_lock() {
        assert!(acquire(true, "http-only-isolated-test").unwrap().is_none());
    }

    #[test]
    fn desktop_startup_is_serialized_across_real_windows_processes() {
        let temporary = temp_dir::TempDir::new().unwrap();
        let name = format!(
            "Local\\RGSM-startup-test-{}-{}",
            std::process::id(),
            temporary.path().file_name().unwrap().to_string_lossy()
        );
        let first_ready = temporary.path().join("first");
        let second_ready = temporary.path().join("second");
        let mut first = child(&name, &first_ready, 500);
        wait_ready(&first_ready);
        let mut second = child(&name, &second_ready, 0);
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !second_ready.exists(),
            "second startup acquired a lock still held by the first"
        );
        assert!(first.wait().unwrap().success());
        assert!(second.wait().unwrap().success());
        assert!(second_ready.exists());
    }

    #[test]
    fn abandoned_startup_lock_is_recovered_without_starting_an_extra_instance() {
        let temporary = temp_dir::TempDir::new().unwrap();
        let name = format!(
            "Local\\RGSM-abandoned-test-{}-{}",
            std::process::id(),
            temporary.path().file_name().unwrap().to_string_lossy()
        );
        let first_ready = temporary.path().join("first");
        let second_ready = temporary.path().join("second");
        let mut first = child(&name, &first_ready, 10_000);
        wait_ready(&first_ready);
        let mut second = child(&name, &second_ready, 0);
        std::thread::sleep(Duration::from_millis(100));
        assert!(!second_ready.exists());
        first.kill().unwrap();
        first.wait().unwrap();
        assert!(second.wait().unwrap().success());
        assert!(second_ready.exists());
    }

    #[test]
    #[ignore = "only launched by the multi-process startup lock tests"]
    fn startup_mutex_child() {
        let name = std::env::var("RGSM_TEST_STARTUP_MUTEX").unwrap();
        let _guard = StartupGuard::acquire_named(&name).unwrap();
        std::fs::write(
            std::env::var_os("RGSM_TEST_STARTUP_READY").unwrap(),
            b"locked",
        )
        .unwrap();
        let duration: u64 = std::env::var("RGSM_TEST_STARTUP_HOLD_MS")
            .unwrap()
            .parse()
            .unwrap();
        std::thread::sleep(Duration::from_millis(duration));
    }
}
