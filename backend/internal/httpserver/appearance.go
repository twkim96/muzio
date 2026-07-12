package httpserver

import (
	"encoding/json"
	"net/http"

	"muzio/backend/internal/config"
)

type AppearanceManager interface {
	GetAppearance() (config.AppearanceSettings, bool, error)
	UpdateAppearance(config.AppearanceSettings) (config.AppearanceSettings, error)
	ResetAppearance() (config.AppearanceSettings, error)
}

type appearanceResponse struct {
	Settings  config.AppearanceSettings `json:"settings"`
	Persisted bool                      `json:"persisted"`
}

type appearanceRequest struct {
	Settings config.AppearanceSettings `json:"settings"`
}

func appearanceHandler(manager AppearanceManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			settings, persisted, err := manager.GetAppearance()
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			writeAppearanceResponse(w, appearanceResponse{
				Settings:  settings,
				Persisted: persisted,
			})
		case http.MethodPut:
			var body appearanceRequest
			if !decodeJSONBody(w, r, &body) {
				return
			}
			settings, err := manager.UpdateAppearance(body.Settings)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			writeAppearanceResponse(w, appearanceResponse{
				Settings:  settings,
				Persisted: true,
			})
		case http.MethodDelete:
			settings, err := manager.ResetAppearance()
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			writeAppearanceResponse(w, appearanceResponse{
				Settings:  settings,
				Persisted: false,
			})
		default:
			w.Header().Set("Allow", "GET, PUT, DELETE")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func writeAppearanceResponse(w http.ResponseWriter, body appearanceResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(body)
}
