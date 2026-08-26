; BESSForge Windows installer (NSIS / Modern UI 2)
;
; Builds a single self-contained Setup executable that installs the
; application and its bundled browser runtime. Installs per-user by default so
; no administrator rights are required.
;
; Compiled by scripts/build-windows-installer.mjs, which stages the payload and
; passes PAYLOAD_GLOB / APP_VERSION / OUT_FILE as /D defines.

Unicode true
ManifestDPIAware true

!ifndef APP_VERSION
  !define APP_VERSION "1.0.1"
!endif
!ifndef PAYLOAD_GLOB
  !error "PAYLOAD_GLOB must be defined by the build script"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "BESSForge-Setup-${APP_VERSION}.exe"
!endif
!ifndef LICENSE_FILE
  !error "LICENSE_FILE must be defined by the build script"
!endif

!define APP_NAME      "BESSForge"
!define APP_EXE       "BESSForge.exe"
!define PUBLISHER     "ECI Electrical Consultants, Inc."
!define DESCRIPTION   "Battery energy storage system preliminary design tool"
!define UNINST_KEY    "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
!define APP_REG_KEY   "Software\${APP_NAME}"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
BrandingText "${PUBLISHER}"

; Per-user install: no UAC prompt, no admin rights needed.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${APP_REG_KEY}" "InstallLocation"

; Solid zlib keeps the installer self-contained while completing reliably on
; constrained build runners. Payload bytes are identical after extraction.
SetCompressor /SOLID zlib

; ------------------------------------------------------------ version info
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey  "ProductName"     "${APP_NAME}"
VIAddVersionKey  "ProductVersion"  "${APP_VERSION}"
VIAddVersionKey  "FileVersion"     "${APP_VERSION}.0"
VIAddVersionKey  "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey  "CompanyName"     "${PUBLISHER}"
VIAddVersionKey  "LegalCopyright"  "Copyright (c) 2026 ${PUBLISHER}"

; ------------------------------------------------------------------- UI
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

!define MUI_ABORTWARNING
; Source-side paths use forward slashes so the POSIX build of makensis can
; resolve them; destination paths stay Windows-style.
!define MUI_ICON   "${NSISDIR}/Contrib/Graphics/Icons/modern-install.ico"
!define MUI_UNICON "${NSISDIR}/Contrib/Graphics/Icons/modern-uninstall.ico"

!define MUI_WELCOMEPAGE_TITLE "Install ${APP_NAME} ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT  "This will install ${APP_NAME} on your computer.$\r$\n$\r$\n${DESCRIPTION}$\r$\n$\r$\nEverything the application needs is included. You do not need Node.js, a web server, or administrator rights.$\r$\n$\r$\nClose ${APP_NAME} if it is currently running, then click Next."

!define MUI_FINISHPAGE_RUN               "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT          "Start ${APP_NAME} now"
!define MUI_FINISHPAGE_LINK              "Installed to $INSTDIR"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT

!define MUI_UNCONFIRMPAGE_TEXT_TOP "${APP_NAME} will be removed from your computer. Your saved project files and exports are not affected."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ------------------------------------------------------------- preflight
Function .onInit
  ; 64-bit Windows 10 or newer.
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${APP_NAME} requires a 64-bit version of Windows."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "${APP_NAME} requires Windows 10 or newer."
    Abort
  ${EndIf}

  ; Offer to close a running instance rather than failing on locked files.
  ; findstr exits 0 only when the process is actually in the task list.
  retry_running:
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${APP_EXE}" /NH | findstr /I /C:"${APP_EXE}"'
  Pop $0 ; exit code
  Pop $1 ; captured output (unused)
  ${If} $0 == 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "${APP_NAME} is currently running.$\r$\n$\r$\nClose it and click Retry to continue." \
      IDRETRY retry_running
    Abort
  ${EndIf}
FunctionEnd

; -------------------------------------------------------------- install
Section "${APP_NAME}" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; Remove a previous installation's program files first so orphaned files
  ; from an older version can never linger next to the new build.
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"

  DetailPrint "Installing application files..."
  File /r "${PAYLOAD_GLOB}"

  ; Verify the payload actually landed before advertising the app.
  IfFileExists "$INSTDIR\${APP_EXE}" +3 0
    MessageBox MB_ICONSTOP "Installation failed: application files could not be written to $INSTDIR."
    Abort

  DetailPrint "Creating shortcuts..."
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut  "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut  "$DESKTOP\${APP_NAME}.lnk"                "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  DetailPrint "Registering the application..."
  WriteUninstaller "$INSTDIR\Uninstall ${APP_NAME}.exe"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall ${APP_NAME}.exe"

  WriteRegStr HKCU "${APP_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${APP_REG_KEY}" "Version"         "${APP_VERSION}"

  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"  "${APP_VERSION}"
  WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"       "${PUBLISHER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\${APP_EXE}"
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall ${APP_NAME}.exe"'
  WriteRegStr   HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall ${APP_NAME}.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; Report the real footprint in Apps & features.
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

; ------------------------------------------------------------ uninstall
Section "Uninstall"
  DetailPrint "Removing shortcuts..."
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir  "$SMPROGRAMS\${APP_NAME}"

  DetailPrint "Removing application files..."
  Delete "$INSTDIR\Uninstall ${APP_NAME}.exe"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\LICENSE*"
  Delete "$INSTDIR\version"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_REG_KEY}"
SectionEnd
