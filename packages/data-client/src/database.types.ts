export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  api: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      activity_v1: {
        Row: {
          client_id: string | null
          detail: string | null
          kind: string | null
          occurred_at: string | null
          ref_id: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          title: string | null
          updated_at: string | null
          url: string | null
        }
        Relationships: []
      }
      campaign_daily_v1: {
        Row: {
          campaign_id: string | null
          campaign_name: string | null
          campaign_status: string | null
          clicks: number | null
          client_id: string | null
          cpc_minor: number | null
          cpp_minor: number | null
          ctr: number | null
          currency: string | null
          day: string | null
          impressions: number | null
          objective: string | null
          purchase_value_minor: number | null
          purchases: number | null
          reach: number | null
          roas: number | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          spend_minor: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_metrics_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "daily_metrics_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_v1: {
        Row: {
          client_id: string | null
          egress_quota_bytes: number | null
          name: string | null
          slug: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          status: "active" | "paused" | "churned" | null
          timezone: string | null
          updated_at: string | null
        }
        Insert: {
          client_id?: string | null
          egress_quota_bytes?: number | null
          name?: string | null
          slug?: string | null
          source?: never
          status?: "active" | "paused" | "churned" | null
          timezone?: string | null
          updated_at?: string | null
        }
        Update: {
          client_id?: string | null
          egress_quota_bytes?: number | null
          name?: string | null
          slug?: string | null
          source?: never
          status?: "active" | "paused" | "churned" | null
          timezone?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      connector_health_v1: {
        Row: {
          client_id: string | null
          computed_at: string | null
          last_error: string | null
          last_run_at: string | null
          last_success_at: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          status: "ok" | "stale" | "auth_failed" | "error" | "never_ran" | null
          status_since: string | null
          updated_at: string | null
        }
        Insert: {
          client_id?: string | null
          computed_at?: string | null
          last_error?: string | null
          last_run_at?: string | null
          last_success_at?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          status?: "ok" | "stale" | "auth_failed" | "error" | "never_ran" | null
          status_since?: string | null
          updated_at?: string | null
        }
        Update: {
          client_id?: string | null
          computed_at?: string | null
          last_error?: string | null
          last_run_at?: string | null
          last_success_at?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          status?: "ok" | "stale" | "auth_failed" | "error" | "never_ran" | null
          status_since?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "connector_health_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "connector_health_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      creative_daily_v1: {
        Row: {
          ad_id: string | null
          ad_name: string | null
          adset_id: string | null
          campaign_id: string | null
          clicks: number | null
          client_id: string | null
          cpc_minor: number | null
          cpp_minor: number | null
          ctr: number | null
          currency: string | null
          day: string | null
          image_hash: string | null
          impressions: number | null
          media_id: string | null
          purchase_value_minor: number | null
          purchases: number | null
          reach: number | null
          roas: number | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          spend_minor: number | null
          storage_path: string | null
          thumb_path: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_metrics_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "daily_metrics_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      customers_v1: {
        Row: {
          attributes: Json | null
          client_id: string | null
          created_at: string | null
          currency: string | null
          email: string | null
          external_id: string | null
          first_order_at: string | null
          id: string | null
          name: string | null
          orders_count: number | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          source_updated_at: string | null
          total_spent_minor: number | null
          updated_at: string | null
        }
        Insert: {
          attributes?: Json | null
          client_id?: string | null
          created_at?: string | null
          currency?: string | null
          email?: string | null
          external_id?: string | null
          first_order_at?: string | null
          id?: string | null
          name?: string | null
          orders_count?: number | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          source_updated_at?: string | null
          total_spent_minor?: number | null
          updated_at?: string | null
        }
        Update: {
          attributes?: Json | null
          client_id?: string | null
          created_at?: string | null
          currency?: string | null
          email?: string | null
          external_id?: string | null
          first_order_at?: string | null
          id?: string | null
          name?: string | null
          orders_count?: number | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          source_updated_at?: string | null
          total_spent_minor?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "customers_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      daily_metrics_v1: {
        Row: {
          client_id: string | null
          currency: string | null
          day: string | null
          entity_id: string | null
          entity_kind: string | null
          metric: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          updated_at: string | null
          value: number | null
        }
        Insert: {
          client_id?: string | null
          currency?: string | null
          day?: string | null
          entity_id?: string | null
          entity_kind?: string | null
          metric?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          updated_at?: string | null
          value?: number | null
        }
        Update: {
          client_id?: string | null
          currency?: string | null
          day?: string | null
          entity_id?: string | null
          entity_kind?: string | null
          metric?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          updated_at?: string | null
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_metrics_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "daily_metrics_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      daily_summary_v1: {
        Row: {
          ad_clicks: number | null
          ad_currency: string | null
          ad_impressions: number | null
          ad_purchase_value_minor: number | null
          ad_purchases: number | null
          ad_spend_minor: number | null
          aov_minor: number | null
          client_id: string | null
          conversion_rate: number | null
          currency: string | null
          day: string | null
          inventory_units: number | null
          orders: number | null
          payouts_minor: number | null
          refunds_minor: number | null
          revenue_minor: number | null
          roas: number | null
          sessions: number | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          updated_at: string | null
        }
        Relationships: []
      }
      egress_status_v1: {
        Row: {
          bytes_used: number | null
          client_id: string | null
          exceeded: boolean | null
          month: string | null
          quota_bytes: number | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          updated_at: string | null
        }
        Relationships: []
      }
      jobs_v1: {
        Row: {
          client_id: string | null
          deleted_at: string | null
          due_on: string | null
          external_id: string | null
          group_name: string | null
          id: string | null
          is_done: boolean | null
          kind: string | null
          owner: string | null
          priority: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          source_updated_at: string | null
          status: string | null
          title: string | null
          updated_at: string | null
          url: string | null
        }
        Insert: {
          client_id?: string | null
          deleted_at?: string | null
          due_on?: string | null
          external_id?: string | null
          group_name?: string | null
          id?: string | null
          is_done?: boolean | null
          kind?: string | null
          owner?: string | null
          priority?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          source_updated_at?: string | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          url?: string | null
        }
        Update: {
          client_id?: string | null
          deleted_at?: string | null
          due_on?: string | null
          external_id?: string | null
          group_name?: string | null
          id?: string | null
          is_done?: boolean | null
          kind?: string | null
          owner?: string | null
          priority?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          source_updated_at?: string | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      media_set_items_v1: {
        Row: {
          added_at: string | null
          client_id: string | null
          media_id: string | null
          position: number | null
          set_id: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          updated_at: string | null
        }
        Insert: {
          added_at?: string | null
          client_id?: string | null
          media_id?: string | null
          position?: number | null
          set_id?: string | null
          source?: never
          updated_at?: string | null
        }
        Update: {
          added_at?: string | null
          client_id?: string | null
          media_id?: string | null
          position?: number | null
          set_id?: string | null
          source?: never
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "media_set_items_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "media_set_items_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "media_set_items_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "creative_daily_v1"
            referencedColumns: ["media_id"]
          },
          {
            foreignKeyName: "media_set_items_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media_v1"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_set_items_set_id_fkey"
            columns: ["set_id"]
            isOneToOne: false
            referencedRelation: "media_sets_v1"
            referencedColumns: ["id"]
          },
        ]
      }
      media_sets_v1: {
        Row: {
          client_id: string | null
          cover_thumb_path: string | null
          created_at: string | null
          description: string | null
          file_count: number | null
          id: string | null
          name: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          updated_at: string | null
        }
        Insert: {
          client_id?: string | null
          cover_thumb_path?: never
          created_at?: string | null
          description?: string | null
          file_count?: never
          id?: string | null
          name?: string | null
          source?: never
          updated_at?: string | null
        }
        Update: {
          client_id?: string | null
          cover_thumb_path?: never
          created_at?: string | null
          description?: string | null
          file_count?: never
          id?: string | null
          name?: string | null
          source?: never
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "media_sets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "media_sets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      media_v1: {
        Row: {
          bytes: number | null
          client_id: string | null
          created_at: string | null
          deleted_at: string | null
          external_id: string | null
          filename: string | null
          height: number | null
          id: string | null
          kind: string | null
          mime: string | null
          purge_after: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          storage_path: string | null
          tags: string[] | null
          thumb_path: string | null
          title: string | null
          updated_at: string | null
          uploaded_by: string | null
          width: number | null
        }
        Insert: {
          bytes?: number | null
          client_id?: string | null
          created_at?: string | null
          deleted_at?: string | null
          external_id?: string | null
          filename?: string | null
          height?: number | null
          id?: string | null
          kind?: string | null
          mime?: string | null
          purge_after?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          storage_path?: string | null
          tags?: string[] | null
          thumb_path?: string | null
          title?: string | null
          updated_at?: string | null
          uploaded_by?: string | null
          width?: number | null
        }
        Update: {
          bytes?: number | null
          client_id?: string | null
          created_at?: string | null
          deleted_at?: string | null
          external_id?: string | null
          filename?: string | null
          height?: number | null
          id?: string | null
          kind?: string | null
          mime?: string | null
          purge_after?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          storage_path?: string | null
          tags?: string[] | null
          thumb_path?: string | null
          title?: string | null
          updated_at?: string | null
          uploaded_by?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "media_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "media_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      memberships_v1: {
        Row: {
          client_id: string | null
          created_at: string | null
          is_smoke: boolean | null
          role: "member" | "owner" | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          client_id?: string | null
          created_at?: string | null
          is_smoke?: boolean | null
          role?: "member" | "owner" | null
          source?: never
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          client_id?: string | null
          created_at?: string | null
          is_smoke?: boolean | null
          role?: "member" | "owner" | null
          source?: never
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "memberships_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "memberships_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      messages_v1: {
        Row: {
          attributes: Json | null
          body: string | null
          client_id: string | null
          external_id: string | null
          id: string | null
          kind: string | null
          occurred_at: string | null
          participants: string[] | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          title: string | null
          updated_at: string | null
          url: string | null
        }
        Insert: {
          attributes?: Json | null
          body?: string | null
          client_id?: string | null
          external_id?: string | null
          id?: string | null
          kind?: string | null
          occurred_at?: string | null
          participants?: string[] | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          title?: string | null
          updated_at?: string | null
          url?: string | null
        }
        Update: {
          attributes?: Json | null
          body?: string | null
          client_id?: string | null
          external_id?: string | null
          id?: string | null
          kind?: string | null
          occurred_at?: string | null
          participants?: string[] | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          title?: string | null
          updated_at?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      money_v1: {
        Row: {
          amount_minor: number | null
          attributes: Json | null
          client_id: string | null
          currency: string | null
          customer_external_id: string | null
          day: string | null
          external_id: string | null
          id: string | null
          items_count: number | null
          kind: string | null
          occurred_at: string | null
          order_number: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          source_updated_at: string | null
          status: string | null
          updated_at: string | null
          url: string | null
        }
        Insert: {
          amount_minor?: number | null
          attributes?: Json | null
          client_id?: string | null
          currency?: string | null
          customer_external_id?: string | null
          day?: string | null
          external_id?: string | null
          id?: string | null
          items_count?: number | null
          kind?: string | null
          occurred_at?: string | null
          order_number?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          source_updated_at?: string | null
          status?: string | null
          updated_at?: string | null
          url?: string | null
        }
        Update: {
          amount_minor?: number | null
          attributes?: Json | null
          client_id?: string | null
          currency?: string | null
          customer_external_id?: string | null
          day?: string | null
          external_id?: string | null
          id?: string | null
          items_count?: number | null
          kind?: string | null
          occurred_at?: string | null
          order_number?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          source_updated_at?: string | null
          status?: string | null
          updated_at?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "money_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "money_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      products_v1: {
        Row: {
          attributes: Json | null
          client_id: string | null
          currency: string | null
          external_id: string | null
          handle: string | null
          id: string | null
          image_url: string | null
          inventory_quantity: number | null
          price_minor: number | null
          product_type: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          status: string | null
          title: string | null
          updated_at: string | null
          url: string | null
          variants_count: number | null
          vendor: string | null
        }
        Insert: {
          attributes?: Json | null
          client_id?: string | null
          currency?: string | null
          external_id?: string | null
          handle?: string | null
          id?: string | null
          image_url?: string | null
          inventory_quantity?: number | null
          price_minor?: number | null
          product_type?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          url?: string | null
          variants_count?: number | null
          vendor?: string | null
        }
        Update: {
          attributes?: Json | null
          client_id?: string | null
          currency?: string | null
          external_id?: string | null
          handle?: string | null
          id?: string | null
          image_url?: string | null
          inventory_quantity?: number | null
          price_minor?: number | null
          product_type?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          status?: string | null
          title?: string | null
          updated_at?: string | null
          url?: string | null
          variants_count?: number | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "products_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
      records_v1: {
        Row: {
          attributes: Json | null
          body: string | null
          client_id: string | null
          external_id: string | null
          id: string | null
          kind: string | null
          occurred_at: string | null
          source:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          title: string | null
          updated_at: string | null
        }
        Insert: {
          attributes?: Json | null
          body?: string | null
          client_id?: string | null
          external_id?: string | null
          id?: string | null
          kind?: string | null
          occurred_at?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          attributes?: Json | null
          body?: string | null
          client_id?: string | null
          external_id?: string | null
          id?: string | null
          kind?: string | null
          occurred_at?: string | null
          source?:
            | "shopify"
            | "meta"
            | "monday"
            | "meet"
            | "upload"
            | "dashboard"
            | "platform"
            | "drive"
            | null
          title?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "records_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_v1"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "records_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "egress_status_v1"
            referencedColumns: ["client_id"]
          },
        ]
      }
    }
    Functions: {
      bulk_tag: {
        Args: { add?: string[]; media_ids: string[]; remove?: string[] }
        Returns: number
      }
      create_media_set: {
        Args: { description?: string; name: string }
        Returns: string
      }
      delete_media: { Args: { media_ids: string[] }; Returns: number }
      delete_media_set: { Args: { set_id: string }; Returns: undefined }
      delete_record: { Args: { record_id: string }; Returns: undefined }
      download_url: { Args: { media_id: string }; Returns: Json }
      register_upload: {
        Args: { path: string; tags?: string[]; title?: string }
        Returns: string
      }
      remove_member: { Args: { target_user_id: string }; Returns: undefined }
      reorder_media_set_items: {
        Args: { media_ids: string[]; set_id: string }
        Returns: undefined
      }
      report_dashboard_version: {
        Args: { api_version: string; app_version: string }
        Returns: undefined
      }
      restore_media: { Args: { media_ids: string[] }; Returns: number }
      save_record: {
        Args: {
          attributes: Json
          body?: string
          external_id?: string
          kind: string
          occurred_at?: string
          title?: string
        }
        Returns: string
      }
      set_media_set_items: {
        Args: { action: string; media_ids: string[]; set_id: string }
        Returns: number
      }
      update_media: {
        Args: { media_id: string; tags?: string[]; title?: string }
        Returns: undefined
      }
      update_media_set: {
        Args: { description?: string; name?: string; set_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  api: {
    Enums: {},
  },
} as const

