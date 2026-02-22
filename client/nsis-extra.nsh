; ZeroTier One далдуур суулгах
!macro customInstall
  DetailPrint "ZeroTier One суулгаж байна..."
  ExecWait 'msiexec /i "$INSTDIR\resources\ZeroTierOne.msi" /qn /norestart'
  DetailPrint "ZeroTier One суулгалт дууслаа."
!macroend

!macro customUnInstall
  ; Дагаад устгахгүй — хэрэглэгч өөр зориулалтаар ашигладаг байж болно
!macroend
