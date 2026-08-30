package com.twkim.videiomusic.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.serverProfileDataStore by preferencesDataStore(name = "server_profile")

data class ServerProfile(
    val displayName: String = "Home server",
    val baseUrl: String = "",
    val note: String? = null,
)

class ProfileStore(private val context: Context) {
    private val displayNameKey = stringPreferencesKey("server_profile_display_name")
    private val baseUrlKey = stringPreferencesKey("server_profile_base_url")
    private val noteKey = stringPreferencesKey("server_profile_note")

    val profile: Flow<ServerProfile> = context.serverProfileDataStore.data.map { preferences ->
        ServerProfile(
            displayName = preferences[displayNameKey]?.trim().orEmpty().ifBlank { "Home server" },
            baseUrl = normalizeBaseUrl(preferences[baseUrlKey].orEmpty()),
            note = preferences[noteKey]?.trim()?.takeIf { it.isNotBlank() },
        )
    }

    suspend fun save(profile: ServerProfile) {
        context.serverProfileDataStore.edit { preferences ->
            preferences[displayNameKey] = profile.displayName.trim().ifBlank { "Home server" }
            preferences[baseUrlKey] = normalizeBaseUrl(profile.baseUrl)
            profile.note?.trim()?.takeIf { it.isNotBlank() }?.let {
                preferences[noteKey] = it
            } ?: preferences.remove(noteKey)
        }
    }
}
