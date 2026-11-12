# Sideload signing key

`sideload.jks` signs every build of this app so that a new APK installs over
the old one without uninstalling first (Android only accepts an update signed
with the same key).

It is committed on purpose and is **not a secret**: its password is in
`app/build.gradle.kts`. That is fine for an app you install by hand on your
own phone. It also means anyone can sign an APK that Android will accept as an
update to this app, so only install APKs you built or downloaded yourself.

Do not use this key for anything published to an app store. For that, create a
private keystore and keep it out of the repository.
