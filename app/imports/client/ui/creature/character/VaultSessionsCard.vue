<template lang="html">
  <!-- Diario delle sessioni dal vault Obsidian (fork helder-local): nascosto se il vault non è configurato -->
  <v-card
    v-if="loading || error || result"
    class="vault-sessions"
  >
    <v-card-title class="text-h6">
      Ultime sessioni
      <v-spacer />
      <v-btn
        icon
        :loading="loading"
        title="Rileggi dal vault"
        @click="load"
      >
        <v-icon>mdi-refresh</v-icon>
      </v-btn>
    </v-card-title>
    <v-card-text v-if="error">
      {{ error }}
    </v-card-text>
    <template v-else-if="result">
      <div
        v-for="(session, i) in result.sessions"
        :key="session.file"
      >
        <v-divider v-if="i > 0" />
        <v-card-text>
          <div class="text-subtitle-1 font-weight-medium">
            {{ session.label }} — {{ session.title }}
          </div>
          <div
            v-if="session.date"
            class="text-caption"
          >
            {{ session.date }}
          </div>
          <div
            v-if="session.missing"
            class="mt-2 font-italic"
          >
            File della sessione non trovato: {{ session.file }}
          </div>
          <template v-else>
            <markdown-text
              v-if="session.recap"
              class="mt-2"
              :markdown="session.recap"
            />
            <div
              v-else
              class="mt-2 font-italic text--secondary"
            >
              Nessun recap
            </div>
            <v-btn
              v-if="session.body"
              text
              small
              class="mt-1 px-0"
              @click="toggle(session.file)"
            >
              {{ open[session.file] ? 'Nascondi testo' : 'Testo completo' }}
              <v-icon right>
                {{ open[session.file] ? 'mdi-chevron-up' : 'mdi-chevron-down' }}
              </v-icon>
            </v-btn>
            <v-expand-transition>
              <markdown-text
                v-if="open[session.file]"
                class="mt-2"
                :markdown="session.body"
              />
            </v-expand-transition>
          </template>
        </v-card-text>
      </div>
      <v-card-actions v-if="result.total > count">
        <v-btn
          text
          :loading="loading"
          @click="more"
        >
          Mostra altre ({{ result.total - count }})
        </v-btn>
      </v-card-actions>
    </template>
  </v-card>
</template>

<script lang="js">
import MarkdownText from '/imports/client/ui/components/MarkdownText.vue';

const PAGE = 5;

export default {
  components: {
    MarkdownText,
  },
  props: {
    creatureId: {
      type: String,
      required: true,
    },
  },
  data() {
    return {
      loading: false,
      error: undefined,
      result: undefined,
      count: PAGE,
      open: {},
    };
  },
  watch: {
    creatureId() {
      this.count = PAGE;
      this.open = {};
      this.load();
    },
  },
  mounted() {
    this.load();
  },
  methods: {
    load() {
      this.loading = true;
      Meteor.call('vault.recentSessions', { creatureId: this.creatureId, count: this.count }, (error, result) => {
        this.loading = false;
        if (error) {
          // Chi non è il proprietario semplicemente non vede la card
          this.error = error.error === 'Permission denied' ? undefined : (error.reason || error.message);
          this.result = undefined;
          return;
        }
        this.error = undefined;
        this.result = result;
      });
    },
    more() {
      this.count += PAGE;
      this.load();
    },
    toggle(file) {
      this.$set(this.open, file, !this.open[file]);
    },
  },
}
</script>

<style lang="css" scoped>
.vault-sessions .markdown >>> h1,
.vault-sessions .markdown >>> h2,
.vault-sessions .markdown >>> h3 {
  font-size: 1rem;
  font-weight: 500;
  line-height: 1.4;
  margin: 12px 0 4px;
}
.vault-sessions .markdown >>> img {
  display: block;
  margin: 8px 0;
  border-radius: 4px;
}
</style>
