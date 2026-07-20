package handler

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/gin-gonic/gin"
)

type sub2APIKey struct {
	ID     int    `json:"id"`
	Key    string `json:"key"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Group  *struct {
		Name                 string `json:"name"`
		Platform             string `json:"platform"`
		AllowImageGeneration bool   `json:"allow_image_generation"`
	} `json:"group,omitempty"`
}

type sub2APIEnvelope[T any] struct {
	Code    int    `json:"code"`
	Data    T      `json:"data"`
	Msg     string `json:"msg"`
	Message string `json:"message"`
}

type sub2APIKeysPayload struct {
	Items []sub2APIKey `json:"items"`
	Pages int          `json:"pages"`
}

type sub2APIUser struct {
	ID           any    `json:"id"`
	Email        string `json:"email"`
	Username     string `json:"username"`
	DisplayName  string `json:"displayName"`
	DisplayName2 string `json:"display_name"`
	Nickname     string `json:"nickname"`
	Name         string `json:"name"`
	AvatarURL    string `json:"avatarUrl"`
	AvatarURL2   string `json:"avatar_url"`
}

var sub2APIHTTPClient = &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}

// Sub2APIEmbedKeys 读取当前 Sub2API 账号可用 Key，并返回受签名保护的同源代理地址。
func Sub2APIEmbedKeys(w http.ResponseWriter, r *http.Request) {
	origin, err := sub2APIOrigin(r.URL.Query().Get("src_host"))
	if err != nil {
		sub2APIError(w, http.StatusBadRequest, err)
		return
	}
	token := bearerToken(r)
	if token == "" {
		sub2APIError(w, http.StatusUnauthorized, errors.New("缺少 Sub2API 登录令牌"))
		return
	}

	keys, status, err := fetchSub2APIKeys(r.Context(), origin, token, r.UserAgent())
	if err != nil {
		sub2APIError(w, status, err)
		return
	}
	target, expires, signature, err := signSub2APIOrigin(origin)
	if err != nil {
		sub2APIError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{
		"sourceOrigin": origin,
		"proxyBaseUrl": service.RequestOrigin(r) + "/api/sub2api/proxy/" + target + "/" + expires + "/" + signature,
		"keys":         keys,
	})
}

func fetchSub2APIKeys(ctx context.Context, origin, token, userAgent string) ([]sub2APIKey, int, error) {
	const pageSize = 1000
	keys := make([]sub2APIKey, 0)

	for page := 1; ; page++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/api/v1/keys?page="+strconv.Itoa(page)+"&page_size="+strconv.Itoa(pageSize), nil)
		if err != nil {
			return nil, http.StatusBadGateway, errors.New("读取 Sub2API Key 失败")
		}
		setSub2APIAuthHeaders(request, token, userAgent)

		response, err := sub2APIHTTPClient.Do(request)
		if err != nil {
			return nil, http.StatusBadGateway, errors.New("读取 Sub2API Key 失败")
		}
		payload := sub2APIEnvelope[sub2APIKeysPayload]{}
		decodeErr := json.NewDecoder(response.Body).Decode(&payload)
		response.Body.Close()
		if decodeErr != nil || response.StatusCode < 200 || response.StatusCode >= 300 || payload.Code != 0 {
			status := response.StatusCode
			if status < 400 || status > 599 {
				status = http.StatusBadGateway
			}
			return nil, status, errors.New(firstSub2APIString(payload.Message, payload.Msg, "读取 Sub2API Key 失败"))
		}

		keys = append(keys, payload.Data.Items...)
		if payload.Data.Pages <= page || len(payload.Data.Items) == 0 {
			return keys, http.StatusOK, nil
		}
	}
}

// Sub2APIEmbedSession 校验 Sub2API 当前用户后创建画布登录会话。
func Sub2APIEmbedSession(w http.ResponseWriter, r *http.Request) {
	origin, err := sub2APIOrigin(r.URL.Query().Get("src_host"))
	if err != nil {
		sub2APIError(w, http.StatusBadRequest, err)
		return
	}
	token := bearerToken(r)
	if token == "" {
		sub2APIError(w, http.StatusUnauthorized, errors.New("缺少 Sub2API 登录令牌"))
		return
	}

	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, origin+"/api/v1/auth/me", nil)
	if err != nil {
		sub2APIError(w, http.StatusBadGateway, errors.New("Sub2API 登录状态无效"))
		return
	}
	setSub2APIAuthHeaders(request, token, r.UserAgent())
	response, err := sub2APIHTTPClient.Do(request)
	if err != nil {
		sub2APIError(w, http.StatusBadGateway, errors.New("Sub2API 登录状态无效"))
		return
	}
	defer response.Body.Close()
	payload := sub2APIEnvelope[sub2APIUser]{}
	_ = json.NewDecoder(response.Body).Decode(&payload)
	if response.StatusCode < 200 || response.StatusCode >= 300 || payload.Code != 0 || strings.TrimSpace(anyString(payload.Data.ID)) == "" {
		sub2APIError(w, response.StatusCode, errors.New(firstSub2APIString(payload.Message, payload.Msg, "Sub2API 登录状态无效")))
		return
	}

	session, err := service.LoginWithSub2APIEmbed(service.Sub2APIEmbedLoginInput{
		SourceOrigin: origin,
		UserID:       anyString(payload.Data.ID),
		Email:        payload.Data.Email,
		Username:     payload.Data.Username,
		DisplayName:  firstSub2APIString(payload.Data.DisplayName, payload.Data.DisplayName2, payload.Data.Nickname, payload.Data.Name, payload.Data.Username, payload.Data.Email),
		AvatarURL:    firstSub2APIString(payload.Data.AvatarURL, payload.Data.AvatarURL2),
	})
	if err != nil {
		sub2APIError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, session)
}

// Sub2APIProxy 仅在来源签名有效时转发 AI 请求。
func Sub2APIProxy(c *gin.Context) {
	origin, err := verifySub2APIOrigin(c.Param("target"), c.Param("expires"), c.Param("signature"))
	if err != nil {
		sub2APIError(c.Writer, http.StatusBadRequest, err)
		return
	}
	path := strings.TrimPrefix(c.Param("path"), "/")
	upstream := origin + "/" + path
	if query := c.Request.URL.RawQuery; query != "" {
		upstream += "?" + query
	}
	request, err := http.NewRequestWithContext(c.Request.Context(), c.Request.Method, upstream, c.Request.Body)
	if err != nil {
		sub2APIError(c.Writer, http.StatusBadRequest, errors.New("Sub2API 代理请求失败"))
		return
	}
	copySub2APIRequestHeaders(request.Header, c.Request.Header)
	response, err := sub2APIHTTPClient.Do(request)
	if err != nil {
		sub2APIError(c.Writer, http.StatusBadGateway, errors.New("Sub2API 代理请求失败"))
		return
	}
	defer response.Body.Close()
	copySub2APIResponseHeaders(c.Writer.Header(), response.Header)
	c.Writer.WriteHeader(response.StatusCode)
	_, _ = io.Copy(c.Writer, response.Body)
}

func sub2APIOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.User != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", errors.New("Sub2API 来源地址格式不正确")
	}
	parsed.Path = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	origin := strings.TrimRight(parsed.String(), "/")
	if !allowedSub2APIOrigin(origin) {
		return "", errors.New("当前 Sub2API 来源不在允许列表中")
	}
	if !config.Cfg.Sub2APIEmbedPrivate && isPrivateSub2APIHost(parsed.Hostname()) {
		return "", errors.New("Sub2API 来源地址不允许使用内网主机")
	}
	return origin, nil
}

func allowedSub2APIOrigin(origin string) bool {
	allowed := strings.Split(config.Cfg.Sub2APIEmbedOrigins, ",")
	for _, value := range allowed {
		candidate := strings.TrimRight(strings.TrimSpace(value), "/")
		if candidate != "" && candidate == origin {
			return true
		}
	}
	return strings.TrimSpace(config.Cfg.Sub2APIEmbedOrigins) == ""
}

func isPrivateSub2APIHost(host string) bool {
	name := strings.Trim(strings.ToLower(host), "[]")
	if name == "localhost" || strings.HasSuffix(name, ".local") {
		return true
	}
	ip := net.ParseIP(name)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())
}

func signSub2APIOrigin(origin string) (string, string, string, error) {
	secret := sub2APIProxySecret()
	if secret == "" {
		return "", "", "", errors.New("Sub2API 嵌入密钥未配置")
	}
	target := base64.RawURLEncoding.EncodeToString([]byte(origin))
	ttl := config.Cfg.Sub2APIEmbedTTL
	if ttl <= 0 {
		ttl = 604800
	}
	expires := time.Now().Add(time.Duration(ttl) * time.Second).Unix()
	return target, int64String(expires), sub2APISignature(origin, expires, secret), nil
}

func verifySub2APIOrigin(target string, expires string, signature string) (string, error) {
	expiresAt, err := parseInt64(expires)
	if err != nil || expiresAt < time.Now().Unix() {
		return "", errors.New("Sub2API 代理地址已过期")
	}
	raw, err := base64.RawURLEncoding.DecodeString(target)
	if err != nil {
		return "", errors.New("Sub2API 代理目标不正确")
	}
	origin, err := sub2APIOrigin(string(raw))
	if err != nil {
		return "", err
	}
	secret := sub2APIProxySecret()
	if secret == "" || subtle.ConstantTimeCompare([]byte(signature), []byte(sub2APISignature(origin, expiresAt, secret))) != 1 {
		return "", errors.New("Sub2API 代理签名无效")
	}
	return origin, nil
}

func sub2APISignature(origin string, expires int64, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(origin + ":" + int64String(expires)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func sub2APIProxySecret() string {
	if secret := strings.TrimSpace(config.Cfg.Sub2APIEmbedSecret); secret != "" {
		return secret
	}
	if config.Cfg.JWTSecret != "infinite-canvas" {
		return strings.TrimSpace(config.Cfg.JWTSecret)
	}
	return ""
}

func copySub2APIRequestHeaders(target http.Header, source http.Header) {
	for key, values := range source {
		switch strings.ToLower(key) {
		case "host", "content-length", "connection", "accept-encoding", "cookie", "x-forwarded-host", "x-forwarded-proto":
			continue
		}
		for _, value := range values {
			target.Add(key, value)
		}
	}
}

func copySub2APIResponseHeaders(target http.Header, source http.Header) {
	for key, values := range source {
		switch strings.ToLower(key) {
		case "content-length", "content-encoding", "transfer-encoding", "connection":
			continue
		}
		for _, value := range values {
			target.Add(key, value)
		}
	}
}

func bearerToken(r *http.Request) string {
	value := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(value) >= 7 && strings.EqualFold(value[:7], "Bearer ") {
		return strings.TrimSpace(value[7:])
	}
	return ""
}

func setSub2APIAuthHeaders(request *http.Request, token, userAgent string) {
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	if userAgent = strings.TrimSpace(userAgent); userAgent != "" {
		request.Header.Set("User-Agent", userAgent)
	}
}

func sub2APIError(w http.ResponseWriter, status int, err error) {
	if status < 400 || status > 599 {
		status = http.StatusBadGateway
	}
	writeJSONWithStatus(w, status, map[string]any{"message": err.Error(), "error": map[string]string{"message": err.Error()}})
}

func firstSub2APIString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func anyString(value any) string {
	switch value := value.(type) {
	case string:
		return strings.TrimSpace(value)
	case float64:
		return int64String(int64(value))
	case json.Number:
		return value.String()
	default:
		return ""
	}
}

func int64String(value int64) string {
	return strconv.FormatInt(value, 10)
}

func parseInt64(value string) (int64, error) {
	return strconv.ParseInt(value, 10, 64)
}
